'use strict';

const packageInfo = require('../package.json');
const { bridgeHome } = require('./core/paths');
const { Journal, JournalValidationError, JournalCorruptError, EVENT_SCHEMA, BOUNDARY_SCHEMA } = require('./core/journal');
const { ConsumerRegistry } = require('./core/consumer-registry');
const { compactJournal } = require('./core/compaction');
const { ensureRuntimeHome } = require('./core/runtime-home');
const semver = require('./core/semver');
const { validateAndNormalizeEvent, EventSchemaError } = require('./core/event-schema');
const {
  normalizeGitUrl,
  resolveRepoContext,
  REPO_IDENTITY_SCHEMA,
  buildRepoIdentityV1,
  isValidRepoIdentityV1,
  repoIdentityKey,
  sameRepoIdentity,
  workspaceIdFor
} = require('./core/repo-context');
const {
  isSyntheticPrompt,
  orderBySequence,
  isDuplicateEvent,
  deriveTurnState,
  assertNoSyntheticEvidence
} = require('./core/turn-identity');
const { normalizeClaudeCode, normalizeCodex, normalizeOpenCode } = require('./core/normalizer');
const projectRegistry = require('./core/project-registry');
const { journalFor, globalJournalDir, projectJournalDir } = require('./core/journal-router');
const { ConversationQuery } = require('./query/conversation-query');
const claudeHookEntry = require('./connectors/claude-code/hook-entry');
const claudeInstaller = require('./installers/claude-code/installer');
const codexInstaller = require('./installers/codex/installer');
const openCodeInstaller = require('./installers/opencode/installer');
const zcodeInstaller = require('./installers/zcode/installer');
const { createBridge } = require('./core/bridge');

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
  REPO_IDENTITY_SCHEMA,
  buildRepoIdentityV1,
  isValidRepoIdentityV1,
  repoIdentityKey,
  sameRepoIdentity,
  workspaceIdFor,
  isSyntheticPrompt,
  orderBySequence,
  isDuplicateEvent,
  deriveTurnState,
  assertNoSyntheticEvidence,
  normalizeClaudeCode,
  normalizeCodex,
  normalizeOpenCode,
  projectRegistry,
  journalFor,
  globalJournalDir,
  projectJournalDir,
  ConversationQuery,
  claudeHookEntry,
  claudeInstaller,
  createBridge,
  installers: {
    claudeCode: claudeInstaller,
    codex: codexInstaller,
    openCode: openCodeInstaller,
    zcode: zcodeInstaller
  }
};
