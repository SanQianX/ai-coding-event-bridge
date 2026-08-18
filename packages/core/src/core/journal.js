'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { CrossProcessLock } = require('./lock');
const { appendLineSync, writeJsonAtomicSync, readJsonIfExists, ensureDirSync } = require('./fs-utils');

const EVENT_SCHEMA = 'ai-coding-event/v1';
const BOUNDARY_SCHEMA = 'git-commit-boundary/v1';

const EVENT_ENVELOPE_FIELDS = [
  'source',
  'eventType',
  'role',
  'content',
  'repoIdentity',
  'projectPath',
  'sessionId',
  'turnId',
  'identityConfidence',
  'branch',
  'headAtCapture',
  'capturedAt',
  'captureStatus',
  'rawEventType'
];

const BOUNDARY_FACT_FIELDS = [
  'commitSha',
  'parents',
  'branch',
  'committedAt',
  'projectId',
  'operationId'
];

class JournalValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalValidationError';
  }
}

class JournalCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptError';
  }
}

function turnKey(repoIdentity, turnId) {
  return `${repoIdentity}::${turnId}`;
}

class Journal {
  constructor(journalDir, { lockStaleMs, lockTimeoutMs } = {}) {
    this.journalDir = journalDir;
    ensureDirSync(journalDir);
    this.eventsFile = path.join(journalDir, 'events.jsonl');
    this.stateFile = path.join(journalDir, 'state.json');
    this.lock = new CrossProcessLock(path.join(journalDir, 'journal.lock'), {
      staleMs: lockStaleMs,
      timeoutMs: lockTimeoutMs
    });
    this._state = null;
    if (!fs.existsSync(this.eventsFile)) {
      const fd = fs.openSync(this.eventsFile, 'a');
      fs.closeSync(fd);
    }
  }

  get firstSequence() {
    return this._state ? this._state.firstSequence : 0;
  }

  get lastSequence() {
    return this._state ? this._state.lastSequence : 0;
  }

  async _withJournalLock(fn) {
    return this.lock.withLock(async () => {
      await this._refreshState();
      return fn();
    });
  }

  _validateEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new JournalValidationError('event must be an object');
    }
    if (typeof event.source !== 'string' || !event.source) {
      throw new JournalValidationError('event.source is required');
    }
    if (typeof event.eventType !== 'string' || !event.eventType) {
      throw new JournalValidationError('event.eventType is required');
    }
    if (event.sequence !== undefined) {
      throw new JournalValidationError('event.sequence is journal-owned and must not be supplied');
    }
    if (event.eventId !== undefined) {
      throw new JournalValidationError('event.eventId is journal-owned and must not be supplied');
    }
    if (event.turnId !== undefined && typeof event.turnId !== 'string') {
      throw new JournalValidationError('event.turnId must be a string when present');
    }
    if (event.sessionId !== undefined && event.sessionId !== null && typeof event.sessionId !== 'string') {
      throw new JournalValidationError('event.sessionId must be a string or null');
    }
  }

  _buildEventRecord(sequence, event) {
    const record = {
      schema: EVENT_SCHEMA,
      eventId: randomUUID(),
      sequence,
      capturedAt: new Date().toISOString()
    };
    for (const field of EVENT_ENVELOPE_FIELDS) {
      if (event[field] !== undefined) record[field] = event[field];
    }
    if (event.meta !== undefined) record.meta = event.meta;
    return record;
  }

  _buildBoundaryRecord(sequence, repoIdentity, gitFacts) {
    const record = {
      schema: BOUNDARY_SCHEMA,
      eventType: 'git_commit_boundary',
      sequence,
      repoIdentity,
      openTurnIdsAtCommit: [],
      previousRepoBoundarySequence: this._state.lastBoundaryByRepo[repoIdentity] || null,
      capturedAt: new Date().toISOString()
    };
    for (const field of BOUNDARY_FACT_FIELDS) {
      if (gitFacts[field] !== undefined) record[field] = gitFacts[field];
    }
    if (gitFacts.meta !== undefined) record.meta = gitFacts.meta;
    return record;
  }

  _applyProjection(record) {
    const { eventType, turnId, repoIdentity, sessionId } = record;
    if (!repoIdentity) return;
    if (eventType === 'user_prompt' && turnId) {
      const key = turnKey(repoIdentity, turnId);
      const existing = this._state.openTurns[key];
      if (existing) {
        existing.lastSequence = record.sequence;
        if (sessionId !== undefined) existing.sessionId = sessionId;
      } else {
        this._state.openTurns[key] = {
          repoIdentity,
          turnId,
          sessionId: sessionId === undefined ? null : sessionId,
          startSequence: record.sequence,
          endSequence: null,
          lastSequence: record.sequence
        };
      }
      return;
    }
    if (eventType === 'assistant_response' && turnId) {
      const key = turnKey(repoIdentity, turnId);
      const existing = this._state.openTurns[key];
      if (existing) {
        existing.endSequence = record.sequence;
        delete this._state.openTurns[key];
      }
      return;
    }
    if (eventType === 'session_end' && sessionId) {
      for (const key of Object.keys(this._state.openTurns)) {
        const turn = this._state.openTurns[key];
        if (turn.repoIdentity === repoIdentity && turn.sessionId === sessionId) {
          turn.endSequence = record.sequence;
          delete this._state.openTurns[key];
        }
      }
    }
  }

  _applyRecordToState(record) {
    if (record.schema === BOUNDARY_SCHEMA) {
      if (record.repoIdentity) {
        this._state.lastBoundaryByRepo[record.repoIdentity] = record.sequence;
      }
    } else {
      this._applyProjection(record);
    }
    if (record.sequence > this._state.lastSequence) {
      this._state.lastSequence = record.sequence;
    }
  }

  _saveState() {
    writeJsonAtomicSync(this.stateFile, this._state);
  }

  _scanFrom(offset) {
    const size = fs.statSync(this.eventsFile).size;
    if (size <= offset) return { records: [], completeBytes: 0 };
    const fd = fs.openSync(this.eventsFile, 'r');
    let raw;
    try {
      const buf = Buffer.alloc(size - offset);
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      raw = buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
    const records = [];
    let completeBytes = 0;
    const chunks = raw.split('\n');
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (i === chunks.length - 1) break; // trailing bytes without newline = partial tail
      const line = chunk;
      if (line.length > 0) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (_) {
          parsed = null;
        }
        if (!parsed || typeof parsed.sequence !== 'number') {
          throw new JournalCorruptError(
            `corrupt journal line at byte offset ${offset + completeBytes}: ${line.slice(0, 80)}`
          );
        }
        records.push(parsed);
      }
      completeBytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    return { records, completeBytes };
  }

  _truncateTo(byteSize) {
    const fd = fs.openSync(this.eventsFile, 'r+');
    try {
      fs.ftruncateSync(fd, byteSize);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  async _refreshState() {
    const size = fs.statSync(this.eventsFile).size;
    const saved = readJsonIfExists(this.stateFile);
    if (!saved || typeof saved.lastSequence !== 'number' || typeof saved.openTurns !== 'object' || saved.openTurns === null) {
      this._fullRebuild();
      return;
    }
    this._state = saved;
    if (typeof this._state.lastBoundaryByRepo !== 'object' || this._state.lastBoundaryByRepo === null) {
      this._state.lastBoundaryByRepo = {};
    }
    if (typeof this._state.firstSequence !== 'number') {
      this._state.firstSequence = this._state.lastSequence ? 1 : 0;
    }
    const flushed = typeof saved.bytesFlushed === 'number' ? saved.bytesFlushed : 0;
    if (size > flushed) {
      this._recoverTail(flushed);
    }
  }

  _fullRebuild() {
    const { records, completeBytes } = this._scanFrom(0);
    if (completeBytes < fs.statSync(this.eventsFile).size) {
      this._truncateTo(completeBytes);
    }
    this._state = {
      firstSequence: records.length ? records[0].sequence : 0,
      lastSequence: records.length ? records[records.length - 1].sequence : 0,
      lastBoundaryByRepo: {},
      openTurns: {},
      bytesFlushed: completeBytes
    };
    for (const record of records) {
      this._applyRecordToState(record);
    }
    this._saveState();
  }

  _recoverTail(fromOffset) {
    const { records, completeBytes } = this._scanFrom(fromOffset);
    const goodEnd = fromOffset + completeBytes;
    if (goodEnd < fs.statSync(this.eventsFile).size) {
      this._truncateTo(goodEnd);
    }
    for (const record of records) {
      this._applyRecordToState(record);
    }
    this._state.bytesFlushed = goodEnd;
    this._saveState();
  }

  async appendEvent(event) {
    this._validateEvent(event);
    return this._withJournalLock(async () => {
      const sequence = this._state.lastSequence + 1;
      const record = this._buildEventRecord(sequence, event);
      appendLineSync(this.eventsFile, `${JSON.stringify(record)}\n`);
      this._applyRecordToState(record);
      this._state.bytesFlushed = fs.statSync(this.eventsFile).size;
      this._saveState();
      return { eventId: record.eventId, sequence };
    });
  }

  async appendCommitBoundary(repoIdentity, gitFacts = {}) {
    if (typeof repoIdentity !== 'string' || !repoIdentity) {
      throw new JournalValidationError('repoIdentity is required for a commit boundary');
    }
    if (gitFacts.commitSha !== undefined && typeof gitFacts.commitSha !== 'string') {
      throw new JournalValidationError('gitFacts.commitSha must be a string when present');
    }
    return this._withJournalLock(async () => {
      const record = this._buildBoundaryRecord(this._state.lastSequence + 1, repoIdentity, gitFacts);
      record.openTurnIdsAtCommit = Object.values(this._state.openTurns)
        .filter((turn) => turn.repoIdentity === repoIdentity)
        .map((turn) => turn.turnId);
      appendLineSync(this.eventsFile, `${JSON.stringify(record)}\n`);
      this._state.bytesFlushed = fs.statSync(this.eventsFile).size;
      this._state.lastSequence = record.sequence;
      this._state.lastBoundaryByRepo[repoIdentity] = record.sequence;
      this._saveState();
      return {
        sequence: record.sequence,
        openTurnIdsAtCommit: record.openTurnIdsAtCommit.slice(),
        previousRepoBoundarySequence: record.previousRepoBoundarySequence
      };
    });
  }

  async readEvents({ fromSequence, toSequence, limit, filter } = {}) {
    return this._withJournalLock(async () => {
      const from = Math.max(
        fromSequence === undefined ? this._state.firstSequence : fromSequence,
        this._state.firstSequence
      );
      const to = toSequence === undefined ? this._state.lastSequence : toSequence;
      const out = [];
      const { records } = this._scanFrom(0);
      for (const record of records) {
        if (record.sequence < from || record.sequence > to) continue;
        if (filter && !filter(record)) continue;
        out.push(record);
        if (limit && out.length >= limit) break;
      }
      return out;
    });
  }

  async getOpenTurns(repoIdentity) {
    return this._withJournalLock(async () =>
      Object.values(this._state.openTurns)
        .filter((turn) => !repoIdentity || turn.repoIdentity === repoIdentity)
        .map((turn) => ({ ...turn }))
    );
  }

  async getBounds() {
    return this._withJournalLock(async () => ({
      firstSequence: this._state.firstSequence,
      lastSequence: this._state.lastSequence
    }));
  }

  _compactTo(target) {
    const { records } = this._scanFrom(0);
    const kept = records.filter((record) => record.sequence > target);
    const removedCount = records.length - kept.length;
    const tmp = `${this.eventsFile}.compact`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (const record of kept) {
      appendLineSync(tmp, `${JSON.stringify(record)}\n`);
    }
    fs.renameSync(tmp, this.eventsFile);
    this._state.firstSequence = target + 1;
    this._state.bytesFlushed = fs.statSync(this.eventsFile).size;
    this._saveState();
    return removedCount;
  }
}

module.exports = {
  Journal,
  JournalValidationError,
  JournalCorruptError,
  EVENT_SCHEMA,
  BOUNDARY_SCHEMA
};
