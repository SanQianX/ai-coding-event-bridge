'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDirSync } = require('./fs-utils');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

class CrossProcessLock {
  constructor(lockFile, { staleMs = 30000, pollMs = 15, timeoutMs = 60000 } = {}) {
    this.lockFile = lockFile;
    this.staleMs = staleMs;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this._held = false;
    this._chain = Promise.resolve();
  }

  async acquire() {
    if (this._held) throw new LockError('lock already held by this handle');
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        try {
          fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
        } finally {
          fs.closeSync(fd);
        }
        this._held = true;
        return;
      } catch (err) {
        // EEXIST: lock file present. EPERM/EBUSY: Windows reports these when
        // another process holds the file without a sharing mode — still "locked".
        if (!err || !['EEXIST', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
      }
      try {
        const st = fs.statSync(this.lockFile);
        if (Date.now() - st.mtimeMs > this.staleMs) {
          fs.rmSync(this.lockFile, { force: true });
          continue;
        }
      } catch (_) {
        // Lock vanished between open failure and stat; retry immediately.
      }
      if (Date.now() > deadline) {
        throw new LockError(`timed out acquiring lock ${this.lockFile}`);
      }
      await sleep(this.pollMs);
    }
  }

  release() {
    if (!this._held) return;
    this._held = false;
    try {
      fs.rmSync(this.lockFile, { force: true });
    } catch (_) {
      // Already removed (stale takeover by another process).
    }
  }

  async withLock(fn) {
    let release = null;
    const run = async () => {
      await this.acquire();
      release = () => this.release();
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const result = this._chain.then(run, run);
    this._chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

function lockPathFor(homeDir, name) {
  const dir = path.join(homeDir, 'locks');
  ensureDirSync(dir);
  return path.join(dir, name);
}

module.exports = { CrossProcessLock, lockPathFor, LockError };
