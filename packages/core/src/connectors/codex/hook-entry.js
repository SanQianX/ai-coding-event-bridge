'use strict';

const fs = require('fs');
const path = require('path');
const { Journal } = require('../../core/journal');
const { validateAndNormalizeEvent } = require('../../core/event-schema');
const { resolveRepoContext } = require('../../core/repo-context');
const { CodexCursorStore } = require('./cursor-store');
const { parseSessionChunk, extractMessage, extractWorkspaceMeta } = require('./session-parser');
const { isCaptureDisabled, captureDisabledResult } = require('../capture-guard');
const { notifyConsumers } = require('../claude-code/notify');

/**
 * Deterministic Codex capture.
 *
 * The notify payload is only a wake-up signal; it never carries the workspace.
 * The real workspace comes from the session's authoritative rollout metadata
 * (session_meta.payload.cwd / turn_context.payload.cwd) — NEVER from the
 * session file's location, which is Codex runtime storage. Bytes are consumed
 * incrementally per session; a partial trailing line stays unread until the
 * next wake-up. When no authoritative cwd can be parsed, a
 * codex-workspace-unresolved gap is recorded and the event is never bound to
 * any project.
 */

function recordGap(home, reason, meta = {}) {
  try {
    const gapsFile = path.join(home, 'journal', 'capture-gaps.jsonl');
    fs.mkdirSync(path.dirname(gapsFile), { recursive: true });
    fs.appendFileSync(
      gapsFile,
      `${JSON.stringify({ schema: 'bridge-capture-gap/v1', source: 'codex', reason, ...meta, at: new Date().toISOString() })}\n`
    );
  } catch (_) {
    // Gap persistence is best effort; the decision to not guess stands regardless.
  }
}

async function findSessionFile(sessionsRoot, sessionId) {
  // Deterministic discovery: Codex rollout files embed the session id in the
  // file name; we search by exact id, never by mtime.
  const stack = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.includes(sessionId)) {
        return full;
      }
    }
  }
  return null;
}

async function captureSession({ home, sessionsRoot, sessionId }) {
  const cursorStore = new CodexCursorStore(home);
  const cursor = cursorStore.read(sessionId) || {};
  const filePath = cursor.filePath || (await findSessionFile(sessionsRoot, sessionId));
  if (!filePath || !fs.existsSync(filePath)) {
    recordGap(home, 'session-file-not-found', { sessionId });
    return { status: 'gap', reason: 'session-file-not-found' };
  }

  const { records, completeBytes } = parseSessionChunk(filePath, cursor.byteOffset || 0);
  const journal = new Journal(path.join(home, 'journal'));
  let captured = 0;
  let lastRecordKey = cursor.lastRecordKey || null;
  let activeCwd = cursor.activeCwd || null;
  let repoIdentity = cursor.repoIdentity || null;
  let projectPath = cursor.projectPath || null;
  let branch = cursor.branch || null;
  let headAtCapture = cursor.headAtCapture || null;
  let unresolvedGapRecorded = false;

  for (const record of records) {
    const meta = extractWorkspaceMeta(record);
    if (meta) {
      if (meta.cwd && meta.cwd !== activeCwd) {
        // Authoritative workspace switch (session start or turn_context change).
        const repo = await resolveRepoContext(meta.cwd);
        activeCwd = meta.cwd;
        repoIdentity = repo.repoIdentity;
        projectPath = repo.projectPath;
        branch = repo.branch;
        headAtCapture = repo.headAtCapture;
      }
      continue;
    }
    const message = extractMessage(record);
    if (!message) continue;
    if (!repoIdentity && !unresolvedGapRecorded) {
      recordGap(home, 'codex-workspace-unresolved', { sessionId });
      unresolvedGapRecorded = true;
    }
    const recordKey = `${path.basename(filePath)}:${(cursor.byteOffset || 0) + completeBytes}:${captured}`;
    const event = validateAndNormalizeEvent({
      source: 'codex',
      eventType: message.role === 'user' ? 'user_prompt' : 'assistant_response',
      role: message.role,
      content: message.text,
      sessionId,
      turnId: message.turnId,
      repoIdentity,
      projectPath,
      branch,
      headAtCapture,
      identityConfidence: message.turnId ? 'exact' : 'partial',
      captureStatus: 'complete',
      rawEventType: record.type || 'message',
      eventKey: `codex:${sessionId}:${recordKey}`,
      meta: { recordKey }
    });
    await journal.appendConversationEvent(event);
    lastRecordKey = recordKey;
    captured += 1;
  }

  cursorStore.write(sessionId, {
    filePath,
    byteOffset: (cursor.byteOffset || 0) + completeBytes,
    lastRecordKey,
    activeCwd,
    repoIdentity,
    projectPath,
    branch,
    headAtCapture
  });
  return { status: 'captured', captured, byteOffset: (cursor.byteOffset || 0) + completeBytes };
}

async function main({ home, payload }) {
  if (isCaptureDisabled(process.env, payload)) {
    return captureDisabledResult();
  }
  if (!payload || typeof payload !== 'object') {
    return { status: 'ignored' };
  }
  const sessionId = payload.session_id || payload.sessionId || null;
  if (!sessionId || typeof sessionId !== 'string') {
    // Ambiguous notify: never fall back to the newest session by mtime.
    recordGap(home, 'notify-session-unresolved', { keys: Object.keys(payload).slice(0, 8) });
    return { status: 'gap', reason: 'notify-session-unresolved' };
  }
  const sessionsRoot =
    payload.sessions_root ||
    (process.env.CODEX_SESSIONS_ROOT) ||
    path.join(home, 'fixtures', 'codex-sessions');
  const result = await captureSession({
    home,
    sessionsRoot,
    sessionId
  });
  if (result.status === 'captured') {
    await notifyConsumers(home, { source: 'codex', sessionId });
  }
  return result;
}

function mainFailOpen({ home, payload }) {
  return main({ home, payload }).catch(() => ({ status: 'fail-open' }));
}

module.exports = { main, mainFailOpen, captureSession, findSessionFile, recordGap };
