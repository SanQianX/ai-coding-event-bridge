'use strict';

const { isValidRepoIdentityV1 } = require('./repo-context');

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

const CONFIDENCE_RANK = { unavailable: 0, partial: 1, exact: 2 };

function clampConfidence(requested, evidence) {
  return CONFIDENCE_RANK[requested] <= CONFIDENCE_RANK[evidence] ? requested : evidence;
}

function raiseConfidenceToEvidence(current, evidence) {
  return CONFIDENCE_RANK[evidence] > CONFIDENCE_RANK[current] ? evidence : current;
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
  if (input.repoIdentity !== undefined && input.repoIdentity !== null) {
    // New automatic data must use repo-identity/v1 objects from
    // resolveRepoContext. Plain strings are legacy records only; malformed
    // objects are rejected so a guessed identity can never enter the journal.
    if (typeof input.repoIdentity !== 'string' && !isValidRepoIdentityV1(input.repoIdentity)) {
      throw new EventSchemaError('repoIdentity must be a valid repo-identity/v1 object, a legacy string, or null', 'repoIdentity');
    }
  }
  if (input.eventKey !== undefined && input.eventKey !== null) {
    if (typeof input.eventKey !== 'string' || !input.eventKey) {
      throw new EventSchemaError('eventKey must be a non-empty string when present', 'eventKey');
    }
  }
  if (input.captureStatus !== undefined && !CAPTURE_STATUSES.includes(input.captureStatus)) {
    throw new EventSchemaError('captureStatus must be complete, partial or gap', 'captureStatus');
  }

  // Confidence may never overstate the captured evidence.
  const evidenceLevel = evidenceLevelFor({ sessionId, turnId });
  const requested = input.identityConfidence || evidenceLevel;
  const identityConfidence = clampConfidence(requested, evidenceLevel);

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
  if (input.eventKey !== undefined) normalized.eventKey = input.eventKey;
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
  FORBIDDEN_SESSION_IDS,
  evidenceLevelFor,
  clampConfidence,
  raiseConfidenceToEvidence
};
