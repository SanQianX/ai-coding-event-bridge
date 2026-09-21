'use strict';

const fs = require('fs');

/**
 * Incremental Codex session JSONL parser. Reads only appended bytes after the
 * cursor offset, tolerates a partial trailing line, and classifies records
 * into messages and workspace metadata. Never re-reads the whole file and
 * never selects sessions by mtime — the caller identifies the session file
 * deterministically.
 */
function parseSessionChunk(filePath, fromOffset) {
  const size = fs.statSync(filePath).size;
  if (size <= fromOffset) return { records: [], recordOffsets: [], completeBytes: 0, size };
  const fd = fs.openSync(filePath, 'r');
  let raw;
  try {
    const buf = Buffer.alloc(size - fromOffset);
    const read = fs.readSync(fd, buf, 0, buf.length, fromOffset);
    raw = buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
  const records = [];
  const recordOffsets = [];
  let completeBytes = 0;
  const chunks = raw.split('\n');
  for (let i = 0; i < chunks.length; i++) {
    const line = chunks[i];
    if (i === chunks.length - 1) break; // trailing bytes without newline = partial
    if (line.length === 0) {
      completeBytes += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      records.push(parsed);
      recordOffsets.push(fromOffset + completeBytes);
    }
    completeBytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  return { records, recordOffsets, completeBytes, size };
}

/**
 * Authoritative workspace metadata from Codex rollout records:
 * session_meta.payload.cwd and turn_context.payload.cwd. A verified
 * turn_context cwd may update the active workspace for subsequent events.
 */
function extractWorkspaceMeta(record) {
  if (!record || typeof record !== 'object') return null;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
  if (record.type === 'session_meta' || (payload && payload.type === 'session_meta')) {
    const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    return { kind: 'session_meta', cwd };
  }
  if (record.type === 'turn_context' || (payload && payload.type === 'turn_context')) {
    const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    return { kind: 'turn_context', cwd };
  }
  return null;
}

function extractMessage(record) {
  if (!record || typeof record !== 'object') return null;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : record;
  const role = payload.role || record.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = collectText(payload.content !== undefined ? payload.content : record.content);
  if (text === null) return null;
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  const nestedTurnId = passthrough && typeof passthrough === 'object' ? passthrough.turn_id : null;
  return {
    role,
    text,
    turnId: payload.turn_id || nestedTurnId || record.turn_id || null,
    phase: typeof payload.phase === 'string' && payload.phase ? payload.phase : null
  };
}

function collectText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
    }
    if (parts.length) return parts.join('\n');
    return null;
  }
  return null;
}

module.exports = { parseSessionChunk, extractMessage, extractWorkspaceMeta };
