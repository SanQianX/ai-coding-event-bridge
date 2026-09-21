'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureDirSync, writeTextAtomicSync } = require('./fs-utils');
const { EVENT_SCHEMA, BOUNDARY_SCHEMA } = require('./journal');
const { ConversationQuery } = require('../query/conversation-query');

// Per-commit conversation sealing: a read-only projection of the routed
// project journal. When a commit boundary lands in a registered project's
// journal, the conversations belonging to that commit are frozen into
// `<store>/commits/<commitSha>.md`. The journal stays the only source of
// truth — sealed files are rebuildable at any time via rebuildSealedFiles.

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

function isUncommittedBoundary(boundary) {
  return Boolean(boundary && boundary.meta && boundary.meta.uncommitted);
}

function sealDirFor(storeDir) {
  return path.join(storeDir, 'commits');
}

function sha256Hex(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function isConversationEvent(record) {
  return record.schema === EVENT_SCHEMA && (record.eventType === 'user_prompt' || record.eventType === 'assistant_response');
}

function isBoundaryRecord(record) {
  return record.schema === BOUNDARY_SCHEMA;
}

// A fence longer than any backtick run inside the content, so bodies can
// never break out of their block.
function fenceFor(content) {
  const runs = String(content == null ? '' : content).match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function localDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDayTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderEventBlock(label, event) {
  const fence = fenceFor(event.content);
  return [`### ${label}`, '', fence, String(event.content == null ? '' : event.content), fence, ''].join('\n');
}

function renderSealedMarkdown({ boundary, turns, unpaired }) {
  // sealedAt is derived from persisted boundary facts (never the wall clock)
  // so a rebuild reproduces byte-identical files.
  const sealedAt = boundary.capturedAt || boundary.committedAt || null;
  const uncommitted = isUncommittedBoundary(boundary);
  const lines = ['---'];
  if (uncommitted) {
    lines.push('subject: 未提交的对话');
    lines.push('uncommitted: true');
  } else {
    lines.push(`commitSha: ${yamlScalar(boundary.commitSha)}`);
    if (boundary.subject !== undefined && boundary.subject !== null) {
      lines.push(`subject: ${yamlScalar(boundary.subject)}`);
    }
  }
  if (boundary.branch !== undefined && boundary.branch !== null) lines.push(`branch: ${yamlScalar(boundary.branch)}`);
  if (boundary.committedAt) lines.push(`committedAt: ${yamlScalar(boundary.committedAt)}`);
  if (sealedAt) lines.push(`sealedAt: ${yamlScalar(sealedAt)}`);
  lines.push(`boundarySequence: ${yamlScalar(boundary.sequence)}`);
  lines.push(`previousBoundarySequence: ${yamlScalar(boundary.previousRepoBoundarySequence == null ? null : boundary.previousRepoBoundarySequence)}`);
  lines.push(`turnCount: ${yamlScalar(turns.length)}`);
  lines.push(`unpairedEventCount: ${yamlScalar(unpaired.length)}`);
  lines.push(`contentHash: ${yamlScalar(sha256Hex(canonicalProof({ boundary, turns, unpaired })))}`);
  lines.push('---', '');
  turns.forEach((turn, index) => {
    const first = (turn.userEvents[0] || turn.assistantEvents[0]);
    const when = localDayTime(first && first.capturedAt);
    const confidence = (first && first.identityConfidence) || 'unavailable';
    lines.push(`## Turn ${index + 1}${when ? ` — ${when}` : ''} (${turn.turnId}, ${confidence})`, '');
    turn.userEvents.forEach((event) => lines.push(renderEventBlock('用户', event)));
    turn.assistantEvents.forEach((event) => lines.push(renderEventBlock('助手', event)));
  });
  if (unpaired.length) {
    lines.push('## 未配对事件', '');
    unpaired.forEach((event) => {
      const label = `${event.role === 'user' ? '用户' : '助手'}${event.turnId ? ` — ${event.turnId}` : ''}`;
      lines.push(renderEventBlock(label, event));
    });
  }
  return `${lines.join('\n')}`;
}

// Provenance digest over the sealed bodies (aligned with the knowledge base's
// frozen-snapshot hashing: content-addressed, no volatile fields).
function canonicalProof({ boundary, turns, unpaired }) {
  return JSON.stringify({
    commitSha: String(boundary.commitSha),
    turns: turns.map((turn) => ({
      turnId: turn.turnId,
      events: turn.userEvents.concat(turn.assistantEvents).map((event) => [event.eventId, event.role, event.content])
    })),
    unpaired: unpaired.map((event) => [event.eventId, event.role, event.content])
  });
}

/**
 * Freeze the conversations belonging to one commit boundary into
 * `<sealDir>/<commitSha>.md`.
 *
 * Belongs-to rule: conversation events with sequence in
 * (previousRepoBoundarySequence, boundary.sequence], plus every turn that was
 * still open at commit time (openTurnIdsAtCommit — the user's ask is the
 * requirement truth even when the reply has not arrived yet). Window events
 * that no selected turn consumed (e.g. a reply that arrived after the previous
 * commit sealed its turn's prompt) are appended as 未配对事件, so every
 * conversation body in the journal lands in at least one sealed file.
 *
 * @returns {sealed, path?, turnCount, unpairedEventCount?, reason?}
 */
async function sealCommitConversations({ journal, sealDir, boundary } = {}) {
  if (!journal) throw new Error('sealCommitConversations requires journal');
  if (typeof sealDir !== 'string' || !sealDir) throw new Error('sealCommitConversations requires sealDir');
  if (!boundary || typeof boundary !== 'object') throw new Error('sealCommitConversations requires boundary');
  const uncommitted = isUncommittedBoundary(boundary);
  const commitSha = String(boundary.commitSha || '').trim().toLowerCase();
  let target;
  if (uncommitted) {
    const day = localDay(boundary.capturedAt || boundary.committedAt) || 'unknown-date';
    if (typeof boundary.sequence !== 'number') {
      return { sealed: false, turnCount: 0, reason: 'boundary-sequence-missing' };
    }
    target = path.join(sealDir, `${day}-uncommitted-${boundary.sequence}.md`);
  } else {
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
      return { sealed: false, turnCount: 0, reason: 'no-commit-sha' };
    }
    target = path.join(sealDir, `${commitSha}.md`);
  }
  if (fs.existsSync(target)) {
    return { sealed: false, path: target, turnCount: 0, reason: 'already-sealed' };
  }
  if (typeof boundary.sequence !== 'number') {
    return { sealed: false, turnCount: 0, reason: 'boundary-sequence-missing' };
  }
  const to = boundary.sequence;
  const from = Math.max((typeof boundary.previousRepoBoundarySequence === 'number' ? boundary.previousRepoBoundarySequence : 0) + 1, 1);

  // Open turns may start before the window, so turns are assembled over the
  // whole prefix up to the boundary — not just the window itself.
  const prefix = (await journal.readEvents({ fromSequence: 1, toSequence: to })).filter(isConversationEvent);
  if (!prefix.length) {
    return { sealed: false, turnCount: 0, reason: 'no-conversations' };
  }
  const query = new ConversationQuery({ journal });
  // _projectTurns is package-internal reuse: the projection shares the exact
  // turn-assembly rule the console's browsing view uses.
  const allTurns = query._projectTurns(prefix);
  const openIds = new Set(boundary.openTurnIdsAtCommit || []);
  const turns = allTurns
    .filter((turn) => openIds.has(turn.turnId) || (turn.startSequence >= from && turn.startSequence <= to))
    .sort((a, b) => a.startSequence - b.startSequence);

  const consumed = new Set();
  for (const turn of turns) {
    for (const event of turn.userEvents.concat(turn.assistantEvents)) consumed.add(event.eventId);
  }
  const unpaired = prefix.filter((event) => event.sequence >= from && event.sequence <= to && !consumed.has(event.eventId));
  if (!turns.length && !unpaired.length) {
    return { sealed: false, turnCount: 0, reason: 'no-conversations' };
  }

  const markdown = renderSealedMarkdown({ boundary: { ...boundary, commitSha }, turns, unpaired });
  ensureDirSync(sealDir);
  writeTextAtomicSync(target, `${markdown}\n`);
  return { sealed: true, path: target, turnCount: turns.length, unpairedEventCount: unpaired.length };
}

/**
 * Age fuse for conversations that will never be committed: when the newest
 * conversation event after the last boundary is older than maxAgeDays, append
 * a synthetic boundary (meta.uncommitted) and seal the tail into
 * commits/<day>-uncommitted-<seq>.md, then trim the journal. Idempotent per
 * run: nothing happens while no new events arrived after the last boundary.
 */
async function sealUncommittedTail({ journal, sealDir, maxAgeDays = 14, now = Date.now() } = {}) {
  if (!journal) throw new Error('sealUncommittedTail requires journal');
  if (typeof sealDir !== 'string' || !sealDir) throw new Error('sealUncommittedTail requires sealDir');
  const records = await journal.readEvents({});
  const boundaries = records.filter(isBoundaryRecord);
  const lastBoundarySeq = boundaries.reduce((max, b) => Math.max(max, b.sequence), 0);
  const tailEvents = records.filter(isConversationEvent).filter((e) => e.sequence > lastBoundarySeq);
  if (!tailEvents.length) {
    return { sealed: false, reason: 'nothing-after-last-boundary' };
  }
  const newest = tailEvents.reduce((a, b) => (String(b.capturedAt || '') > String(a.capturedAt || '') ? b : a));
  const ageMs = now - Date.parse(newest.capturedAt || '');
  if (!Number.isFinite(ageMs) || ageMs < maxAgeDays * 86400000) {
    return { sealed: false, reason: 'too-young' };
  }
  const repoIdentity = newest.repoIdentity;
  if (!repoIdentity) {
    return { sealed: false, reason: 'no-repo-identity' };
  }
  const appended = await journal.appendCommitBoundary(repoIdentity, { meta: { uncommitted: true } });
  const boundary = {
    commitSha: undefined,
    capturedAt: newest.capturedAt,
    sequence: appended.sequence,
    openTurnIdsAtCommit: appended.openTurnIdsAtCommit,
    previousRepoBoundarySequence: appended.previousRepoBoundarySequence,
    meta: { uncommitted: true }
  };
  const result = await sealCommitConversations({ journal, sealDir, boundary });
  if (result.sealed || (result.reason === 'already-sealed' && fs.existsSync(result.path))) {
    const trim = await journal.trimThrough(appended.sequence);
    return { ...result, trimmedThrough: trim.trimmedThrough };
  }
  return result;
}

/**
 * Boot-time reconciliation: trim the journal through the newest boundary
 * whose sealed file verifiably exists on disk. Heals the window between a
 * successful seal and a crashed trim, and adopts pre-upgrade journals that
 * already carry sealed commits.
 */
async function reconcileTrim({ journal, sealDir } = {}) {
  if (!journal) throw new Error('reconcileTrim requires journal');
  if (typeof sealDir !== 'string' || !sealDir) throw new Error('reconcileTrim requires sealDir');
  const records = await journal.readEvents({});
  const boundaries = records
    .filter(isBoundaryRecord)
    .filter((b) => COMMIT_SHA_PATTERN.test(String(b.commitSha || '')))
    .sort((a, b) => b.sequence - a.sequence);
  for (const boundary of boundaries) {
    if (fs.existsSync(path.join(sealDir, `${String(boundary.commitSha).toLowerCase()}.md`))) {
      const trim = await journal.trimThrough(boundary.sequence);
      return { trimmedThrough: trim.trimmedThrough, commitSha: boundary.commitSha, reason: trim.reason };
    }
  }
  return { trimmedThrough: null, reason: 'no-sealed-boundary' };
}

/**
 * Re-create any missing sealed file from the journal's persisted boundary
 * records (disaster recovery). Existing files are left untouched, so a rebuild
 * never rewrites history.
 */
async function rebuildSealedFiles({ journal, sealDir } = {}) {
  if (!journal) throw new Error('rebuildSealedFiles requires journal');
  if (typeof sealDir !== 'string' || !sealDir) throw new Error('rebuildSealedFiles requires sealDir');
  const boundaries = (await journal.readEvents({})).filter(isBoundaryRecord);
  const results = [];
  for (const boundary of boundaries) {
    results.push(await sealCommitConversations({ journal, sealDir, boundary }));
  }
  return {
    boundaryCount: boundaries.length,
    sealedCount: results.filter((result) => result.sealed).length,
    results
  };
}

module.exports = { sealDirFor, sealCommitConversations, rebuildSealedFiles, sealUncommittedTail, reconcileTrim };
