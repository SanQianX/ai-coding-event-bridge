'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, readJsonIfExists, ensureDirSync } = require('../../core/fs-utils');

/**
 * Atomic per-session cursor state. One JSON file per Codex session under
 * <home>/cursors/codex/, written via rename so a crash never corrupts it.
 * Cursor v2 stores an independent offset and workspace context for every
 * rollout file. A v1 cursor is upgraded in memory without resetting its
 * consumed offset, so discovering a continuation file never replays history.
 */
const CURSOR_SCHEMA = 'codex-cursor/v2';

function fileState(state = {}) {
  return {
    filePath: state.filePath,
    byteOffset: Number.isInteger(state.byteOffset) && state.byteOffset >= 0 ? state.byteOffset : 0,
    lastRecordKey: state.lastRecordKey || null,
    activeCwd: state.activeCwd || null,
    repoIdentity: state.repoIdentity || null,
    projectPath: state.projectPath || null,
    branch: state.branch || null,
    headAtCapture: state.headAtCapture || null
  };
}

function normalizeCursor(sessionId, state) {
  const normalized = { schema: CURSOR_SCHEMA, sessionId: String(sessionId), files: {} };
  if (!state || typeof state !== 'object') return normalized;

  if (state.schema === CURSOR_SCHEMA && state.files && typeof state.files === 'object') {
    for (const [key, value] of Object.entries(state.files)) {
      if (!value || typeof value !== 'object' || typeof value.filePath !== 'string') continue;
      normalized.files[key] = fileState(value);
    }
    return normalized;
  }

  // v1 compatibility: preserve the exact consumed offset and context. The
  // caller supplies the canonical key after resolving the legacy file path.
  if (typeof state.filePath === 'string' && state.filePath) {
    normalized.legacyFile = fileState(state);
  }
  return normalized;
}

class CodexCursorStore {
  constructor(homeDir) {
    this.dir = path.join(homeDir, 'cursors', 'codex');
    ensureDirSync(this.dir);
  }

  _fileFor(sessionId) {
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  read(sessionId) {
    return normalizeCursor(sessionId, readJsonIfExists(this._fileFor(sessionId)));
  }

  write(sessionId, state) {
    const normalized = normalizeCursor(sessionId, state);
    writeJsonAtomicSync(this._fileFor(sessionId), {
      schema: CURSOR_SCHEMA,
      sessionId: normalized.sessionId,
      files: normalized.files,
      updatedAt: new Date().toISOString()
    });
  }

  clear(sessionId) {
    try {
      fs.rmSync(this._fileFor(sessionId), { force: true });
    } catch (_) {
      // Already gone.
    }
  }
}

module.exports = { CodexCursorStore, CURSOR_SCHEMA, normalizeCursor };
