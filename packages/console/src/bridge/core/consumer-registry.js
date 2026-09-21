'use strict';

const fs = require('fs');
const path = require('path');
const { CrossProcessLock, lockPathFor } = require('./lock');
const { writeJsonAtomicSync, readJsonIfExists, ensureDirSync } = require('./fs-utils');

class ConsumerRegistry {
  constructor(homeDir) {
    // Pure reads on a machine without a Bridge home must not create one;
    // the directory is materialized on the first write.
    this.homeDir = homeDir;
    this.consumersFile = path.join(homeDir, 'consumers.json');
    this.lock = new CrossProcessLock(lockPathFor(homeDir, 'install.lock'));
  }

  async _withLock(fn) {
    return this.lock.withLock(fn);
  }

  _read() {
    const saved = readJsonIfExists(this.consumersFile);
    if (saved && typeof saved === 'object' && Array.isArray(saved.consumers)) {
      return saved;
    }
    return { schema: 'bridge-consumers/v1', consumers: [] };
  }

  _write(state) {
    ensureDirSync(this.homeDir);
    writeJsonAtomicSync(this.consumersFile, state);
  }

  async registerConsumer(name, meta = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('consumer name is required');
    }
    return this._withLock(async () => {
      const state = this._read();
      let entry = state.consumers.find((c) => c.name === name);
      if (!entry) {
        entry = { name, ack: 0, registeredAt: new Date().toISOString(), meta: {} };
        state.consumers.push(entry);
      }
      entry.meta = { ...(entry.meta || {}), ...meta };
      entry.lastSeenAt = new Date().toISOString();
      this._write(state);
      return { ...entry };
    });
  }

  async unregisterConsumer(name) {
    return this._withLock(async () => {
      const state = this._read();
      const before = state.consumers.length;
      state.consumers = state.consumers.filter((c) => c.name !== name);
      this._write(state);
      return { removed: before - state.consumers.length };
    });
  }

  async ackConsumerCursor(name, sequence) {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new TypeError('ack sequence must be a non-negative integer');
    }
    return this._withLock(async () => {
      const state = this._read();
      const entry = state.consumers.find((c) => c.name === name);
      if (!entry) {
        const err = new Error(`consumer ${name} is not registered`);
        err.code = 'CONSUMER_NOT_REGISTERED';
        throw err;
      }
      if (sequence > entry.ack) {
        entry.ack = sequence;
      }
      entry.lastSeenAt = new Date().toISOString();
      this._write(state);
      return { name, ack: entry.ack };
    });
  }

  async getConsumers() {
    if (!fs.existsSync(this.consumersFile)) return [];
    return this._withLock(async () => {
      const state = this._read();
      return state.consumers.map((c) => ({ ...c }));
    });
  }

  async getMinAck() {
    if (!fs.existsSync(this.consumersFile)) return null;
    return this._withLock(async () => {
      const state = this._read();
      if (state.consumers.length === 0) return null;
      return state.consumers.reduce((min, c) => Math.min(min, c.ack), Number.POSITIVE_INFINITY);
    });
  }
}

module.exports = { ConsumerRegistry };
