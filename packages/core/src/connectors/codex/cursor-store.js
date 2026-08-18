'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, readJsonIfExists, ensureDirSync } = require('../../core/fs-utils');

/**
 * Atomic per-session cursor state. One JSON file per Codex session under
 * <home>/cursors/codex/, written via rename so a crash never corrupts it.
 * State updates are all-or-nothing; concurrent writers serialize through the
 * caller's journal lock discipline.
 */
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
    return readJsonIfExists(this._fileFor(sessionId));
  }

  write(sessionId, state) {
    writeJsonAtomicSync(this._fileFor(sessionId), {
      sessionId: String(sessionId),
      filePath: state.filePath,
      byteOffset: Number.isInteger(state.byteOffset) ? state.byteOffset : 0,
      lastRecordKey: state.lastRecordKey || null,
      repoIdentity: state.repoIdentity || null,
      projectPath: state.projectPath || null,
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

module.exports = { CodexCursorStore };
