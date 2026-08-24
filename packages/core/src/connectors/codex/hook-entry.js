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
const { CrossProcessLock } = require('../../core/lock');

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

function normalizedPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileKey(sessionsRoot, filePath) {
  return path.relative(path.resolve(sessionsRoot), path.resolve(filePath)).split(path.sep).join('/');
}

async function findSessionFiles(sessionsRoot, sessionId) {
  // Deterministic discovery: Codex rollout files embed the session id in the
  // file name; we search by exact id, never by mtime.
  const stack = [sessionsRoot];
  const matches = [];
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
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
        matches.push(full);
      }
    }
  }
  return matches.sort((left, right) => fileKey(sessionsRoot, left).localeCompare(fileKey(sessionsRoot, right)));
}

async function findSessionFile(sessionsRoot, sessionId) {
  const files = await findSessionFiles(sessionsRoot, sessionId);
  return files[0] || null;
}

function emptyFileState(filePath) {
  return {
    filePath,
    byteOffset: 0,
    lastRecordKey: null,
    activeCwd: null,
    repoIdentity: null,
    projectPath: null,
    branch: null,
    headAtCapture: null
  };
}

async function captureSessionUnlocked({ home, sessionsRoot, sessionId, cursorStore }) {
  const cursor = cursorStore.read(sessionId);
  const filePaths = await findSessionFiles(sessionsRoot, sessionId);
  if (!filePaths.length) {
    recordGap(home, 'session-file-not-found', { sessionId });
    return { status: 'gap', reason: 'session-file-not-found' };
  }

  if (cursor.legacyFile) {
    const legacyMatch = filePaths.find(candidate => normalizedPath(candidate) === normalizedPath(cursor.legacyFile.filePath));
    if (legacyMatch) {
      cursor.files[fileKey(sessionsRoot, legacyMatch)] = { ...cursor.legacyFile, filePath: legacyMatch };
    }
    delete cursor.legacyFile;
  }

  const journal = new Journal(path.join(home, 'journal'));
  let captured = 0;
  let completeBytes = 0;

  for (const filePath of filePaths) {
    const key = fileKey(sessionsRoot, filePath);
    const state = cursor.files[key] || emptyFileState(filePath);
    state.filePath = filePath;
    const fromOffset = state.byteOffset || 0;
    const parsed = parseSessionChunk(filePath, fromOffset);
    let unresolvedGapRecorded = false;

    for (let index = 0; index < parsed.records.length; index += 1) {
      const record = parsed.records[index];
      const meta = extractWorkspaceMeta(record);
      if (meta) {
        if (meta.cwd && meta.cwd !== state.activeCwd) {
          // Authoritative workspace switch (session start or turn_context change).
          const repo = await resolveRepoContext(meta.cwd);
          state.activeCwd = meta.cwd;
          state.repoIdentity = repo.repoIdentity;
          state.projectPath = repo.projectPath;
          state.branch = repo.branch;
          state.headAtCapture = repo.headAtCapture;
        }
        continue;
      }
      const message = extractMessage(record);
      if (!message) continue;
      if (!state.repoIdentity && !unresolvedGapRecorded) {
        recordGap(home, 'codex-workspace-unresolved', { sessionId, rolloutFile: key });
        unresolvedGapRecorded = true;
      }
      const byteOffset = parsed.recordOffsets[index];
      const recordKey = `${key}:${byteOffset}`;
      const event = validateAndNormalizeEvent({
        source: 'codex',
        eventType: message.role === 'user' ? 'user_prompt' : 'assistant_response',
        role: message.role,
        content: message.text,
        sessionId,
        turnId: message.turnId,
        repoIdentity: state.repoIdentity,
        projectPath: state.projectPath,
        branch: state.branch,
        headAtCapture: state.headAtCapture,
        identityConfidence: message.turnId ? 'exact' : 'partial',
        captureStatus: 'complete',
        rawEventType: record.type || 'message',
        eventKey: `codex:${sessionId}:${recordKey}`,
        meta: { recordKey, rolloutFile: key, byteOffset, phase: message.phase }
      });
      const appended = await journal.appendConversationEvent(event);
      state.lastRecordKey = recordKey;
      if (!appended.duplicate) captured += 1;
    }

    state.byteOffset = fromOffset + parsed.completeBytes;
    cursor.files[key] = state;
    completeBytes += parsed.completeBytes;
  }

  cursorStore.write(sessionId, cursor);
  return { status: 'captured', captured, files: filePaths.length, completeBytes };
}

async function captureSession({ home, sessionsRoot, sessionId }) {
  const cursorStore = new CodexCursorStore(home);
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  const lock = new CrossProcessLock(path.join(home, 'cursors', 'codex', `${safe}.capture.lock`));
  return lock.withLock(() => captureSessionUnlocked({ home, sessionsRoot, sessionId, cursorStore }));
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
  if (result.status === 'captured' && result.captured > 0) {
    await notifyConsumers(home, { source: 'codex', sessionId });
  }
  return result;
}

function mainFailOpen({ home, payload }) {
  return main({ home, payload }).catch(() => ({ status: 'fail-open' }));
}

module.exports = { main, mainFailOpen, captureSession, findSessionFile, findSessionFiles, recordGap };
