'use strict';

const path = require('path');
const { Journal } = require('./journal');
const { findProject } = require('./project-registry');

/**
 * Capture-side journal routing. Events for a registered project (matched by
 * repoIdentity.workspaceId) are appended to that project's journal at
 * `<store>/journal`; everything else — unknown repos and events with no repo
 * identity — goes to the global journal at `<home>/journal`, so capture never
 * depends on the registry being readable. Journal instances are cached per
 * directory for the life of the process (the Codex connector appends many
 * records per wake-up).
 */

const journalCache = new Map();

function globalJournalDir(home) {
  return path.join(home, 'journal');
}

function projectJournalDir(project) {
  return path.join(project.store, 'journal');
}

function journalFor(home, repoIdentity) {
  let dir = globalJournalDir(home);
  const project = findProject(home, repoIdentity);
  if (project) dir = projectJournalDir(project);
  let journal = journalCache.get(dir);
  if (!journal) {
    journal = new Journal(dir);
    journalCache.set(dir, journal);
  }
  return journal;
}

module.exports = { journalFor, globalJournalDir, projectJournalDir };
