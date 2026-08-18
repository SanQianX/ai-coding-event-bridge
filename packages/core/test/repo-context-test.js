'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { normalizeGitUrl, resolveRepoContext } = require('../src/core/repo-context');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

async function main() {
  // URL normalization: all common forms of the same origin collapse.
  assert.strictEqual(normalizeGitUrl('git@github.com:acme/repo.git'), 'github.com/acme/repo');
  assert.strictEqual(normalizeGitUrl('https://github.com/acme/repo.git'), 'github.com/acme/repo');
  assert.strictEqual(normalizeGitUrl('https://github.com/acme/repo'), 'github.com/acme/repo');
  assert.strictEqual(normalizeGitUrl('ssh://git@github.com/acme/repo'), 'github.com/acme/repo');
  assert.strictEqual(normalizeGitUrl('git@gitlab.com:team/sub/project.git'), 'gitlab.com/team/sub/project');
  assert.strictEqual(normalizeGitUrl(''), null);
  assert.strictEqual(normalizeGitUrl(null), null);

  // A real temporary repo resolves exact identity from origin.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-repo-context-'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/temp-fixture.git'], { cwd: dir });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir });

  const ctx = await resolveRepoContext(dir);
  assert.strictEqual(ctx.repoIdentity, 'github.com/acme/temp-fixture');
  assert.strictEqual(ctx.identityConfidence, 'exact');
  assert.strictEqual(ctx.branch, 'main');
  assert.match(ctx.headAtCapture, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(ctx.projectPath));

  // A repo without origin falls back to path identity with partial confidence.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-repo-context-'));
  await run('git', ['init', '-q'], { cwd: dir2 });
  const ctx2 = await resolveRepoContext(dir2);
  assert.strictEqual(ctx2.identityConfidence, 'partial');
  assert.ok(typeof ctx2.repoIdentity === 'string' && ctx2.repoIdentity.length > 0);

  // Outside a repo identity is explicitly unavailable, never guessed.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plain-'));
  const ctx3 = await resolveRepoContext(plain);
  assert.strictEqual(ctx3.identityConfidence, 'unavailable');
  assert.strictEqual(ctx3.repoIdentity, null);

  console.log('repo-context-test PASS');
}

module.exports = main();
