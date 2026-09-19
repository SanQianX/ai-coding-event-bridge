'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRepoIdentityV1 } = require('../src/core/repo-context');
const {
  addProject,
  removeProject,
  listProjects,
  loadRegistry,
  registryFile
} = require('../src/core/project-registry');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-registry-'));

function makeRepoDir(name) {
  const dir = path.join(HOME, 'repos', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolverFor(dir, { remote = null } = {}) {
  const repoIdentity = buildRepoIdentityV1({ workspaceRoot: dir, remote });
  return async () => ({
    repoIdentity,
    projectPath: dir,
    branch: 'main',
    headAtCapture: null,
    identityConfidence: 'exact'
  });
}

async function expectErrorCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err && err.code}: ${err && err.message}`);
    return;
  }
  throw new Error(`expected error code ${code}, but the call succeeded`);
}

async function main() {
  // --- addProject with default store ---
  const demoDir = makeRepoDir('demo');
  const demo = await addProject({ home: HOME, path: demoDir, resolveRepo: resolverFor(demoDir, { remote: 'github.com/acme/demo' }) });
  assert.strictEqual(demo.name, 'demo');
  assert.strictEqual(demo.path, demoDir);
  assert.strictEqual(demo.remote, 'github.com/acme/demo');
  assert.strictEqual(demo.store, path.join(HOME, 'projects', 'demo'));
  assert.ok(fs.existsSync(path.join(demo.store, 'journal')), 'default store journal dir is materialized');
  assert.ok(demo.createdAt);

  // Registry file persisted and reloadable.
  const persisted = loadRegistry(HOME);
  assert.strictEqual(persisted.version, 1);
  assert.strictEqual(persisted.projects.length, 1);
  assert.deepStrictEqual(listProjects(HOME).map((project) => project.id), [demo.id]);

  // --- custom store honored ---
  const customStore = path.join(HOME, 'custom-store');
  const otherDir = makeRepoDir('other');
  const other = await addProject({ home: HOME, path: otherDir, store: customStore, resolveRepo: resolverFor(otherDir) });
  assert.strictEqual(other.store, customStore);
  assert.ok(fs.existsSync(path.join(customStore, 'journal')));

  // --- import path resolution: a subdirectory resolves to the repo root identity ---
  const nestedDir = makeRepoDir('nested');
  const nestedSub = path.join(nestedDir, 'packages', 'deep');
  fs.mkdirSync(nestedSub, { recursive: true });
  const fromSub = await addProject({ home: HOME, path: nestedSub, resolveRepo: resolverFor(nestedDir) });
  assert.strictEqual(fromSub.path, nestedDir);

  // --- duplicate rejection (same resolved root) ---
  await expectErrorCode(
    addProject({ home: HOME, path: otherDir, resolveRepo: resolverFor(otherDir) }),
    'PROJECT_DUPLICATE'
  );

  // --- store conflict across projects ---
  const thirdDir = makeRepoDir('third');
  await expectErrorCode(
    addProject({ home: HOME, path: thirdDir, store: customStore, resolveRepo: resolverFor(thirdDir) }),
    'PROJECT_STORE_CONFLICT'
  );

  // --- validation errors ---
  await expectErrorCode(addProject({ home: HOME, path: path.join(HOME, 'missing') }), 'PROJECT_DIR_INVALID');
  await expectErrorCode(
    addProject({ home: HOME, path: makeRepoDir('plain'), resolveRepo: async () => ({ repoIdentity: null, projectPath: null }) }),
    'PROJECT_NOT_GIT'
  );
  await expectErrorCode(addProject({ home: HOME }), 'PROJECT_PATH_REQUIRED');

  // --- removeProject unregisters without touching disk ---
  const removed = await removeProject({ home: HOME, id: demo.id });
  assert.strictEqual(removed.id, demo.id);
  assert.ok(fs.existsSync(path.join(demo.store, 'journal')), 'removed project data stays on disk');
  assert.deepStrictEqual(
    listProjects(HOME).map((project) => project.id).sort(),
    [other.id, fromSub.id].sort()
  );
  await expectErrorCode(removeProject({ home: HOME, id: demo.id }), 'PROJECT_NOT_FOUND');

  // --- corrupt registry degrades to empty, never throws ---
  fs.writeFileSync(registryFile(HOME), '{not json', 'utf8');
  assert.deepStrictEqual(listProjects(HOME), []);

  console.log('project-registry-test: ok');
}

module.exports = main();
