'use strict';

const path = require('path');
const crypto = require('crypto');
const { Journal } = require('../core/journal');

/**
 * Headless conversation query over the durable journal. This is the controlled
 * business query surface: it may return full user/assistant bodies, supports
 * cursor pagination for virtualized UIs, and never depends on a host database.
 */
class ConversationQuery {
  constructor({ journalDir, journal } = {}) {
    this.journal = journal || new Journal(journalDir);
  }

  async _events() {
    return this.journal.readEvents({});
  }

  _isConversationEvent(record) {
    return (
      record.schema === 'ai-coding-event/v1'
      && (record.eventType === 'user_prompt' || record.eventType === 'assistant_response')
    );
  }

  async listProjects() {
    const events = (await this._events()).filter(e => this._isConversationEvent(e) && e.repoIdentity);
    const byProject = new Map();
    for (const event of events) {
      const entry = byProject.get(event.repoIdentity) || {
        repoIdentity: event.repoIdentity,
        projectPath: event.projectPath || null,
        sources: new Set(),
        eventCount: 0,
        lastSequence: 0,
        lastCapturedAt: null
      };
      entry.sources.add(event.source);
      entry.eventCount += 1;
      if (event.sequence > entry.lastSequence) {
        entry.lastSequence = event.sequence;
        entry.lastCapturedAt = event.capturedAt || null;
      }
      byProject.set(event.repoIdentity, entry);
    }
    return [...byProject.values()]
      .map(entry => ({ ...entry, sources: [...entry.sources] }))
      .sort((a, b) => b.lastSequence - a.lastSequence);
  }

  async listSessions({ project } = {}) {
    const events = (await this._events()).filter(
      e => this._isConversationEvent(e) && (!project || e.repoIdentity === project) && e.sessionId
    );
    const bySession = new Map();
    for (const event of events) {
      const entry = bySession.get(event.sessionId) || {
        sessionId: event.sessionId,
        repoIdentity: event.repoIdentity,
        source: event.source,
        eventCount: 0,
        firstSequence: event.sequence,
        lastSequence: event.sequence
      };
      entry.eventCount += 1;
      entry.lastSequence = Math.max(entry.lastSequence, event.sequence);
      entry.firstSequence = Math.min(entry.firstSequence, event.sequence);
      bySession.set(event.sessionId, entry);
    }
    return [...bySession.values()].sort((a, b) => b.lastSequence - a.lastSequence);
  }

  _localDay(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _projectTurns(events) {
    // Turn assembly by turnId; assistant events without turnId bind to the
    // single open turn of their session (same rule as the journal projection).
    const turns = [];
    const open = new Map();
    for (const event of events) {
      if (event.eventType === 'user_prompt' && event.turnId) {
        const turn = {
          turnId: event.turnId,
          sessionId: event.sessionId || null,
          source: event.source,
          repoIdentity: event.repoIdentity,
          day: this._localDay(event.capturedAt),
          startSequence: event.sequence,
          endSequence: event.sequence,
          userEvents: [],
          assistantEvents: []
        };
        turn.userEvents.push(this._projectEvent(event));
        turns.push(turn);
        open.set(event.turnId, turn);
      } else if (event.eventType === 'assistant_response') {
        let turn = event.turnId ? open.get(event.turnId) : null;
        if (!turn && event.sessionId) {
          const openForSession = [...open.values()].filter(t => t.sessionId === event.sessionId);
          if (openForSession.length === 1) turn = openForSession[0];
        }
        if (turn) {
          turn.assistantEvents.push(this._projectEvent(event));
          turn.endSequence = event.sequence;
          open.delete(turn.turnId);
        }
        // Orphan assistant evidence is intentionally not surfaced as a turn.
      }
    }
    return turns;
  }

  _projectEvent(event) {
    // Controlled projection: full conversation bodies, journal internals stripped.
    return {
      sequence: event.sequence,
      eventId: event.eventId,
      role: event.role,
      content: event.content === undefined ? null : event.content,
      source: event.source,
      sessionId: event.sessionId || null,
      turnId: event.turnId || null,
      capturedAt: event.capturedAt || null,
      identityConfidence: event.identityConfidence || 'unavailable',
      captureStatus: event.captureStatus || 'complete'
    };
  }

  _encodeCursor(turns, lastIndex) {
    return Buffer.from(
      JSON.stringify({ v: 1, last: turns[lastIndex] ? turns[lastIndex].startSequence : 0, n: lastIndex + 1 })
    ).toString('base64url');
  }

  async turns({ project, date, cursor, limit = 50 } = {}) {
    const all = (await this._events()).filter(
      e => this._isConversationEvent(e) && (!project || e.repoIdentity === project)
    );
    let turns = this._projectTurns(all);
    if (date) turns = turns.filter(t => t.day === date);
    turns.sort((a, b) => a.startSequence - b.startSequence);
    let start = 0;
    if (cursor) {
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      } catch (_) {
        decoded = null;
      }
      if (!decoded || decoded.v !== 1 || typeof decoded.last !== 'number') {
        const err = new Error('conversation cursor is invalid; restart the query');
        err.code = 'LOG_CURSOR_EXPIRED';
        throw err;
      }
      start = turns.findIndex(t => t.startSequence > decoded.last);
      if (start === -1) start = turns.length;
    }
    const pageSize = Math.max(1, Math.min(Number(limit) || 50, 200));
    const page = turns.slice(start, start + pageSize);
    return {
      project: project || null,
      date: date || null,
      turns: page,
      nextCursor: start + pageSize < turns.length ? this._encodeCursor(turns, start + pageSize - 1) : null,
      totalTurns: turns.length
    };
  }

  async searchConversations({ project, q, limit = 20 } = {}) {
    const needle = String(q || '').toLowerCase();
    const events = (await this._events()).filter(
      e => this._isConversationEvent(e) && (!project || e.repoIdentity === project) && typeof e.content === 'string' && e.content.toLowerCase().includes(needle)
    );
    return {
      matches: events
        .slice(-Math.max(1, Math.min(Number(limit) || 20, 100)))
        .reverse()
        .map(e => this._projectEvent(e))
    };
  }
}

module.exports = { ConversationQuery };
