'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { buildRepoIdentityV1, resolveRepoContext } = require('../src/bridge/core/repo-context');
const { addProject } = require('../src/bridge/core/project-registry');
const { journalFor, globalJournalDir, projectJournalDir } = require('../src/bridge/core/journal-router');
const { createBridge } = require('../src/bridge/core/bridge');
const claudeHookEntry = require('../src/bridge/connectors/claude-code/hook-entry');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-journal-routing-'));

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

function readJournalLines(journalDir) {
  const file = path.join(journalDir, 'events.jsonl');
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

async function main() {
  // ---------- journalFor: registry-driven routing ----------
  const projectDir = path.join(HOME, 'work', 'routed-app');
  fs.mkdirSync(projectDir, { recursive: true });
  const store = path.join(HOME, 'stores', 'routed-app');
  const identity = buildRepoIdentityV1({ workspaceRoot: projectDir });
  await addProject({ home: HOME, path: projectDir, store, resolveRepo: async () => ({ repoIdentity: identity, projectPath: projectDir }) });

  const routed = journalFor(HOME, identity);
  assert.strictEqual(routed.journalDir, projectJournalDir({ store }), 'registered identity routes to the project journal');
  assert.strictEqual(journalFor(HOME, identity), routed, 'journal instances are cached per directory');

  const global = journalFor(HOME, null);
  assert.strictEqual(global.journalDir, globalJournalDir(HOME), 'no identity routes to the global journal');
  const unknownIdentity = buildRepoIdentityV1({ workspaceRoot: path.join(HOME, 'work', 'not-imported') });
  assert.strictEqual(journalFor(HOME, unknownIdentity).journalDir, globalJournalDir(HOME), 'unregistered identity routes to the global journal');

  // ---------- end to end: connector capture honors the registry ----------
  const repoDir = path.join(HOME, 'work', 'git-project');
  fs.mkdirSync(repoDir, { recursive: true });
  await git(['init', '-q'], repoDir);
  const repoContext = await resolveRepoContext(repoDir);
  assert.ok(repoContext.repoIdentity, 'test fixture repo resolves an identity');
  const entry = await addProject({ home: HOME, path: repoDir });
  assert.ok(fs.existsSync(path.join(entry.store, 'journal')), 'import materializes the project journal');

  const result = await claudeHookEntry.main({
    home: HOME,
    payload: {
      hookName: 'UserPromptSubmit',
      session_id: 'sess-routing-1',
      cwd: repoDir,
      prompt: 'route me to the project journal'
    }
  });
  assert.strictEqual(result.status, 'captured');

  const projectRecords = readJournalLines(path.join(entry.store, 'journal'));
  const capturedEvents = projectRecords.filter(
    (record) => record.schema === 'ai-coding-event/v1' && record.content === 'route me to the project journal'
  );
  assert.strictEqual(capturedEvents.length, 1, 'claude event landed in the project journal');
  const globalRecords = readJournalLines(globalJournalDir(HOME)).filter(
    (record) => record.schema === 'ai-coding-event/v1'
  );
  assert.strictEqual(globalRecords.length, 0, 'registered project events never leak into the global journal');

  // ---------- facade boundary routing + cursor semantics ----------
  const bridge = createBridge({ homeDir: HOME });
  const boundary = await bridge.appendCommitBoundary({
    repoIdentity: repoContext.repoIdentity,
    commitSha: '9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f90a',
    branch: 'main'
  });
  // The journal is a conveyor: the sealed boundary trims itself out of the
  // project journal once its archive file exists on disk.
  const sealedFile = path.join(entry.store, 'commits', '9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f90a.md');
  assert.ok(fs.existsSync(sealedFile), 'boundary for a registered repo seals into the project store');
  assert.ok(fs.readFileSync(sealedFile, 'utf8').includes('route me to the project journal'), 'captured conversation is archived');
  assert.strictEqual(readJournalLines(path.join(entry.store, 'journal')).length, 0, 'sealed prefix is trimmed from the journal');
  assert.strictEqual(boundary.projection.sealed, true, 'projection reports the seal');
  assert.strictEqual(boundary.bridgeCursorAtCommit, 0, 'routed boundary keeps the global watermark conservative');

  const unknownRepoBoundary = await bridge.appendCommitBoundary({
    repoIdentity: unknownIdentity,
    commitSha: '77b0e12a1b2c3d4e5f60718293a4b5c6d7e8f90a',
    branch: 'main'
  });
  const globalBoundaries = readJournalLines(globalJournalDir(HOME)).filter(
    (record) => record.schema === 'git-commit-boundary/v1'
  );
  assert.strictEqual(globalBoundaries.length, 1, 'unregistered repo boundary stays in the global journal');
  assert.strictEqual(unknownRepoBoundary.bridgeCursorAtCommit, unknownRepoBoundary.sequence, 'global boundary keeps cursor == sequence');

  console.log('journal-routing-test: ok');
}

module.exports = main();
