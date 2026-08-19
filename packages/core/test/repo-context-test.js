'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  normalizeGitUrl,
  resolveRepoContext,
  buildRepoIdentityV1,
  isValidRepoIdentityV1,
  repoIdentityKey,
  workspaceIdFor
} = require('../src/core/repo-context');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

function gitIdentity(dir, originUrl) {
  return (async () => {
    await run('git', ['init', '-q'], { cwd: dir });
    if (originUrl) await run('git', ['remote', 'add', 'origin', originUrl], { cwd: dir });
    await run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await run('git', ['add', '.'], { cwd: dir });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  })();
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

  // repo-identity/v1 helpers.
  const identity = buildRepoIdentityV1({ workspaceRoot: 'D:\\Projects\\CCS', commonDir: 'D:\\Projects\\CCS\\.git', remote: 'github.com/SanQianX/CCS' });
  assert.strictEqual(identity.schema, 'repo-identity/v1');
  assert.match(identity.workspaceId, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(identity.workspaceRoot, 'D:\\Projects\\CCS');
  assert.ok(isValidRepoIdentityV1(identity));
  assert.strictEqual(repoIdentityKey(identity), identity.workspaceId);
  assert.strictEqual(repoIdentityKey('legacy-string'), 'legacy-string');
  assert.strictEqual(repoIdentityKey(null), null);
  assert.ok(!isValidRepoIdentityV1({ schema: 'repo-identity/v1', workspaceId: 'nope', workspaceRoot: 5 }));

  // Mandatory test 7: no Git repo => unavailable, never guessed.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plain-'));
  const ctxPlain = await resolveRepoContext(plain);
  assert.strictEqual(ctxPlain.identityConfidence, 'unavailable');
  assert.strictEqual(ctxPlain.repoIdentity, null);

  // Mandatory tests 1-3: nested cwd, two repos, same origin different clones.
  const ccs = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ccs-'));
  const ccb = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ccb-'));
  const cloneB = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ccs-clone-'));
  await gitIdentity(ccs, 'git@github.com:acme/ccs.git');
  await gitIdentity(ccb, 'git@github.com:acme/ccb.git');
  await gitIdentity(cloneB, 'git@github.com:acme/ccs.git'); // same origin as ccs

  const ctxRoot = await resolveRepoContext(ccs);
  assert.strictEqual(ctxRoot.identityConfidence, 'exact');
  assert.ok(isValidRepoIdentityV1(ctxRoot.repoIdentity));
  assert.strictEqual(ctxRoot.repoIdentity.remote, 'github.com/acme/ccs');
  assert.strictEqual(ctxRoot.branch, 'main');
  assert.match(ctxRoot.headAtCapture, /^[0-9a-f]{40}$/);
  assert.strictEqual(ctxRoot.projectPath, path.resolve(ccs));

  // 1. nested folder inside the repo resolves to the same workspaceId.
  const nested = path.join(ccs, 'modules', 'foo');
  fs.mkdirSync(nested, { recursive: true });
  const ctxNested = await resolveRepoContext(nested);
  assert.strictEqual(ctxNested.repoIdentity.workspaceId, ctxRoot.repoIdentity.workspaceId);
  assert.strictEqual(ctxNested.repoIdentity.workspaceRoot, ctxRoot.repoIdentity.workspaceRoot);

  // 2. two separate repos => different workspaceId.
  const ctxCcb = await resolveRepoContext(ccb);
  assert.notStrictEqual(ctxCcb.repoIdentity.workspaceId, ctxRoot.repoIdentity.workspaceId);

  // 3. two clones with the same origin => different workspaceId, same remote.
  const ctxCloneB = await resolveRepoContext(cloneB);
  assert.strictEqual(ctxCloneB.repoIdentity.remote, ctxRoot.repoIdentity.remote);
  assert.notStrictEqual(ctxCloneB.repoIdentity.workspaceId, ctxRoot.repoIdentity.workspaceId);

  // Mandatory test 4: worktrees share commonDir but keep distinct workspaceId.
  const worktreeA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-')), 'wt-a');
  const worktreeB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-wt-')), 'wt-b');
  const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-wtmain-'));
  await gitIdentity(mainRepo, 'git@github.com:acme/worktrees.git');
  await run('git', ['worktree', 'add', '-q', worktreeA, 'HEAD'], { cwd: mainRepo });
  await run('git', ['worktree', 'add', '-q', worktreeB, 'HEAD'], { cwd: mainRepo });
  const ctxWtA = await resolveRepoContext(worktreeA);
  const ctxWtB = await resolveRepoContext(worktreeB);
  const ctxMain = await resolveRepoContext(mainRepo);
  assert.strictEqual(ctxWtA.repoIdentity.commonDir, ctxMain.repoIdentity.commonDir);
  assert.strictEqual(ctxWtB.repoIdentity.commonDir, ctxMain.repoIdentity.commonDir);
  assert.notStrictEqual(ctxWtA.repoIdentity.workspaceId, ctxWtB.repoIdentity.workspaceId);
  assert.notStrictEqual(ctxWtA.repoIdentity.workspaceId, ctxMain.repoIdentity.workspaceId);
  assert.notStrictEqual(ctxWtB.repoIdentity.workspaceId, ctxMain.repoIdentity.workspaceId);
  assert.notStrictEqual(ctxWtA.repoIdentity.workspaceRoot, ctxWtB.repoIdentity.workspaceRoot);

  // Mandatory test 5: Windows case variation => same identity on win32 semantics.
  if (process.platform === 'win32') {
    const varied = ctxRoot.repoIdentity.workspaceRoot.charAt(0).toLowerCase() + ctxRoot.repoIdentity.workspaceRoot.slice(1);
    if (varied !== ctxRoot.repoIdentity.workspaceRoot) {
      const ctxVaried = await resolveRepoContext(varied);
      assert.strictEqual(ctxVaried.repoIdentity.workspaceId, ctxRoot.repoIdentity.workspaceId);
    }
    assert.strictEqual(
      workspaceIdFor('D:\\Projects\\CCS'),
      workspaceIdFor('d:/projects/ccs')
    );
  } else {
    assert.notStrictEqual(workspaceIdFor('/tmp/CCS'), workspaceIdFor('/tmp/ccs'));
  }

  // Mandatory test 6: spaces and unicode paths keep exact identity.
  const unicodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-空间 ünicode-'));
  await gitIdentity(unicodeRoot, null);
  const ctxUnicode = await resolveRepoContext(unicodeRoot);
  assert.strictEqual(ctxUnicode.identityConfidence, 'exact');
  assert.strictEqual(ctxUnicode.repoIdentity.workspaceRoot, path.resolve(unicodeRoot));

  // Mandatory test 8: origin missing => workspace still exact, remote null.
  assert.strictEqual(ctxUnicode.repoIdentity.remote, null);
  assert.strictEqual(ctxUnicode.repoIdentity.commonDir, path.join(path.resolve(unicodeRoot), '.git'));

  console.log('repo-context-test PASS');
}

module.exports = main();
