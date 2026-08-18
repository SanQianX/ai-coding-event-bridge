'use strict';

const SOURCES = ['claude-code', 'codex', 'opencode'];
const IDENTITY_CONFIDENCE_LEVELS = ['exact', 'partial', 'unavailable'];
const CAPTURE_STATUSES = ['complete', 'partial', 'gap'];
const ROLES = ['user', 'assistant'];

// AUD-ID-001: a shared fake session id aggregates unrelated events.
const FORBIDDEN_SESSION_IDS = new Set(['', 'unknown-session', 'unknown', 'null', 'none']);

class EventSchemaError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'EventSchemaError';
    this.field = field;
  }
}

function evidenceLevelFor({ sessionId, turnId }) {
  if (sessionId && turnId) return 'exact';
  if (sessionId || turnId) return 'partial';
  return 'unavailable';
}

function validateAndNormalizeEvent(input) {
  if (!input || typeof input !== 'object') {
    throw new EventSchemaError('event must be an object', 'event');
  }
  if (!SOURCES.includes(input.source)) {
    throw new EventSchemaError(`source must be one of ${SOURCES.join(', ')}`, 'source');
  }
  if (typeof input.eventType !== 'string' || !input.eventType) {
    throw new EventSchemaError('eventType is required', 'eventType');
  }
  if (input.role !== undefined && input.role !== null && !ROLES.includes(input.role)) {
    throw new EventSchemaError('role must be user, assistant or null', 'role');
  }
  if (input.content !== undefined && input.content !== null && typeof input.content !== 'string') {
    throw new EventSchemaError('content must be a string or null', 'content');
  }

  let sessionId = input.sessionId === undefined ? null : input.sessionId;
  if (sessionId !== null) {
    if (typeof sessionId !== 'string') {
      throw new EventSchemaError('sessionId must be a string or null', 'sessionId');
    }
    if (FORBIDDEN_SESSION_IDS.has(sessionId.toLowerCase())) {
      throw new EventSchemaError('fake session ids such as unknown-session are forbidden', 'sessionId');
    }
  }
  let turnId = input.turnId === undefined ? null : input.turnId;
  if (turnId !== null && typeof turnId !== 'string') {
    throw new EventSchemaError('turnId must be a string or null', 'turnId');
  }

  if (
    input.identityConfidence !== undefined &&
    !IDENTITY_CONFIDENCE_LEVELS.includes(input.identityConfidence)
  ) {
    throw new EventSchemaError('identityConfidence must be exact, partial or unavailable', 'identityConfidence');
  }
  if (input.captureStatus !== undefined && !CAPTURE_STATUSES.includes(input.captureStatus)) {
    throw new EventSchemaError('captureStatus must be complete, partial or gap', 'captureStatus');
  }

  // Confidence may never overstate the captured evidence.
  const evidenceLevel = evidenceLevelFor({ sessionId, turnId });
  const requested = input.identityConfidence || evidenceLevel;
  const rank = { unavailable: 0, partial: 1, exact: 2 };
  const identityConfidence = rank[requested] <= rank[evidenceLevel] ? requested : evidenceLevel;

  const normalized = {
    source: input.source,
    eventType: input.eventType,
    role: input.role === undefined ? null : input.role,
    sessionId,
    turnId,
    identityConfidence,
    captureStatus: input.captureStatus || 'complete'
  };
  if (input.content !== undefined) normalized.content = input.content;
  if (input.repoIdentity !== undefined) normalized.repoIdentity = input.repoIdentity;
  if (input.projectPath !== undefined) normalized.projectPath = input.projectPath;
  if (input.branch !== undefined) normalized.branch = input.branch;
  if (input.headAtCapture !== undefined) normalized.headAtCapture = input.headAtCapture;
  if (input.capturedAt !== undefined) normalized.capturedAt = input.capturedAt;
  if (input.rawEventType !== undefined) normalized.rawEventType = input.rawEventType;
  if (input.meta !== undefined) normalized.meta = input.meta;
  return normalized;
}

module.exports = {
  validateAndNormalizeEvent,
  EventSchemaError,
  SOURCES,
  IDENTITY_CONFIDENCE_LEVELS,
  CAPTURE_STATUSES,
  FORBIDDEN_SESSION_IDS
};
