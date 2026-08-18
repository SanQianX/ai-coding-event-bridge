'use strict';

const packageInfo = require('../package.json');
const { bridgeHome } = require('./core/paths');
const { Journal, JournalValidationError, JournalCorruptError, EVENT_SCHEMA, BOUNDARY_SCHEMA } = require('./core/journal');
const { ConsumerRegistry } = require('./core/consumer-registry');
const { compactJournal } = require('./core/compaction');
const { ensureRuntimeHome } = require('./core/runtime-home');
const semver = require('./core/semver');
const { validateAndNormalizeEvent, EventSchemaError } = require('./core/event-schema');
const { normalizeGitUrl, resolveRepoContext } = require('./core/repo-context');
const {
  isSyntheticPrompt,
  orderBySequence,
  isDuplicateEvent,
  deriveTurnState,
  assertNoSyntheticEvidence
} = require('./core/turn-identity');
const { normalizeClaudeCode, normalizeCodex, normalizeOpenCode } = require('./core/normalizer');

module.exports = {
  packageName: packageInfo.name,
  version: packageInfo.version,
  bridgeHome,
  Journal,
  JournalValidationError,
  JournalCorruptError,
  EVENT_SCHEMA,
  BOUNDARY_SCHEMA,
  ConsumerRegistry,
  compactJournal,
  ensureRuntimeHome,
  semver,
  validateAndNormalizeEvent,
  EventSchemaError,
  normalizeGitUrl,
  resolveRepoContext,
  isSyntheticPrompt,
  orderBySequence,
  isDuplicateEvent,
  deriveTurnState,
  assertNoSyntheticEvidence,
  normalizeClaudeCode,
  normalizeCodex,
  normalizeOpenCode
};
