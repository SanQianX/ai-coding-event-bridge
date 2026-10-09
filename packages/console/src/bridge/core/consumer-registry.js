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

  async ackConsumerCursor(name, sequence, { journalId = 'global' } = {}) {
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
      if (journalId === 'global') entry.ack = Math.max(entry.ack || 0, sequence);
      else {
        if (!consumesJournal(entry, journalId)) throw new Error(`consumer ${name} is not registered for journal ${journalId}`);
        entry.cursors = { ...(entry.cursors || {}), [journalId]: Math.max((entry.cursors || {})[journalId] || 0, sequence) };
      }
      entry.lastSeenAt = new Date().toISOString();
      this._write(state);
      return { name, journalId, ack: journalId === 'global' ? entry.ack : entry.cursors[journalId] };
    });
  }

  async getConsumers() {
    if (!fs.existsSync(this.consumersFile)) return [];
    return this._withLock(async () => {
      const state = this._read();
      return state.consumers.map((c) => ({ ...c }));
    });
  }

  async getMinAck({ journalId = 'global' } = {}) {
    if (!fs.existsSync(this.consumersFile)) return null;
    return this._withLock(async () => {
      const state = this._read();
      const consumers = state.consumers.filter(c => consumesJournal(c, journalId));
      if (consumers.length === 0) return null;
      return consumers.reduce((min, c) => Math.min(min, journalId === 'global' ? c.ack || 0 : (c.cursors || {})[journalId] || 0), Number.POSITIVE_INFINITY);
    });
  }
}

// Legacy consumers are global-only. An explicit wildcard protects journals
// created after registration too; an offline consumer is never expired.
function consumesJournal(consumer, journalId) {
  const journals = consumer.meta && consumer.meta.journals;
  return Array.isArray(journals) ? journals.includes('*') || journals.includes(journalId) : journalId === 'global';
}

module.exports = { ConsumerRegistry, consumesJournal };
