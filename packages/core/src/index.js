'use strict';

const packageInfo = require('../package.json');
const { bridgeHome } = require('./core/paths');
const { Journal, JournalValidationError, JournalCorruptError, EVENT_SCHEMA, BOUNDARY_SCHEMA } = require('./core/journal');
const { ConsumerRegistry } = require('./core/consumer-registry');
const { compactJournal } = require('./core/compaction');
const { ensureRuntimeHome } = require('./core/runtime-home');
const semver = require('./core/semver');

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
  semver
};
