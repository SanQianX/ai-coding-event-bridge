'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { resolveRepoContext } = require('../src/core/repo-context');
const { addProject } = require('../src/core/project-registry');
const { createBridge } = require('../src/core/bridge');
const { Journal } = require('../src/core/journal');
const { sealCommitConversations, rebuildSealedFiles, sealDirFor } = require('../src/core/commit-projection');
const claudeHookEntry = require('../src/connectors/claude-code/hook-entry');

const CLI = path.resolve(__dirname, '..', 'src', 'bin', 'commit-boundary.js');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).trim();
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJournalLines(journalDir) {
  return fs
    .readFileSync(path.join(journalDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function setupProject(name) {
  const home = tmpdir('bridge-seal-home-');
  const repo = path.join(home, 'work', name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'seal-test@example.com']);
  git(repo, ['config', 'user.name', 'Seal Test']);
  const store = path.join(home, 'knowledge', name, 'dev-conversations');
  await addProject({ home, path: repo, store });
  const { repoIdentity } = await resolveRepoContext(repo);
  return { home, repo, store, repoIdentity };
}

async function say({ home, repo, session, prompt }) {
  const result = await claudeHookEntry.main({
    home,
    payload: { hookName: 'UserPromptSubmit', session_id: session, cwd: repo, prompt }
  });
  assert.strictEqual(result.status, 'captured');
}

async function reply({ home, repo, session, message }) {
  const result = await claudeHookEntry.main({
    home,
    payload: { hookName: 'Stop', session_id: session, cwd: repo, last_assistant_message: message }
  });
  assert.strictEqual(result.status, 'captured');
}

async function main() {
  // ---------- 1. routed project: seal fires on appendCommitBoundary ----------
  const one = await setupProject('routed-seal');
  await say({ home: one.home, repo: one.repo, session: 'sess-seal-1', prompt: '把登录页改成深色主题' });
  await reply({ home: one.home, repo: one.repo, session: 'sess-seal-1', message: '已把登录页配色改为深色主题，并调整了对比度。' });
  await say({ home: one.home, repo: one.repo, session: 'sess-seal-1', prompt: '再补一个注销按钮' });
  await reply({ home: one.home, repo: one.repo, session: 'sess-seal-1', message: '已在导航栏右侧补上注销按钮。' });
  const bridgeOne = createBridge({ homeDir: one.home });
  const boundaryOne = await bridgeOne.appendCommitBoundary({
    repoIdentity: one.repoIdentity,
    commitSha: SHA_A,
    branch: 'main',
    committedAt: '2026-09-20T10:00:00Z'
  });
  assert.strictEqual(boundaryOne.projection.sealed, true, 'routed boundary seals conversations');
  assert.strictEqual(boundaryOne.projection.turnCount, 2, 'both turns belong to the commit');
  const fileOne = path.join(sealDirFor(one.store), `${SHA_A}.md`);
  assert.ok(fs.existsSync(fileOne), 'sealed file exists at <store>/commits/<sha>.md');
  const textOne = fs.readFileSync(fileOne, 'utf8');
  assert.match(textOne, /^---\n/, 'frontmatter opens the file');
  assert.ok(textOne.includes(`commitSha: ${SHA_A}`), 'frontmatter carries the commit sha');
  assert.ok(textOne.includes('branch: main'), 'frontmatter carries the branch');
  assert.ok(textOne.includes('committedAt:'), 'frontmatter carries the commit date');
  assert.ok(textOne.includes('boundarySequence:'), 'frontmatter carries the boundary sequence');
  assert.ok(textOne.includes('turnCount: 2'), 'frontmatter carries the turn count');
  assert.ok(textOne.includes('contentHash:'), 'frontmatter carries the provenance hash');
  assert.ok(textOne.includes('把登录页改成深色主题'), 'user prompt body is sealed');
  assert.ok(textOne.includes('已把登录页配色改为深色主题'), 'assistant body is sealed');
  assert.ok(textOne.includes('### 用户'), 'user sections render');
  assert.ok(textOne.includes('### 助手'), 'assistant sections render');
  assert.ok(!textOne.includes('未配对事件'), 'fully paired turns produce no appendix');

  // ---------- 2. straddling turn: open turn seals now, late reply next ----------
  const two = await setupProject('straddle');
  const bridgeTwo = createBridge({ homeDir: two.home });
  await say({ home: two.home, repo: two.repo, session: 'sess-straddle', prompt: '先提交，回复稍后到' });
  const boundaryA = await bridgeTwo.appendCommitBoundary({ repoIdentity: two.repoIdentity, commitSha: SHA_A, branch: 'main' });
  assert.strictEqual(boundaryA.projection.sealed, true, 'open turn at commit time is sealed');
  const fileA = fs.readFileSync(path.join(sealDirFor(two.store), `${SHA_A}.md`), 'utf8');
  assert.ok(fileA.includes('先提交，回复稍后到'), 'the open turn user prompt is requirement truth for commit A');
  assert.ok(!fileA.includes('这是迟到的回复'), 'the reply had not arrived at commit A');
  await reply({ home: two.home, repo: two.repo, session: 'sess-straddle', message: '这是迟到的回复' });
  const boundaryB = await bridgeTwo.appendCommitBoundary({ repoIdentity: two.repoIdentity, commitSha: SHA_B, branch: 'main' });
  assert.strictEqual(boundaryB.projection.sealed, true, 'commit B seals too');
  const fileB = fs.readFileSync(path.join(sealDirFor(two.store), `${SHA_B}.md`), 'utf8');
  assert.ok(fileB.includes('未配对事件'), 'the late reply renders as an unpaired appendix');
  assert.ok(fileB.includes('这是迟到的回复'), 'late reply body is never dropped');
  assert.ok(!fileB.includes('先提交，回复稍后到'), 'the already-sealed prompt stays in commit A only');
  assert.strictEqual(boundaryB.projection.turnCount, 0, 'no whole turn belongs to commit B');

  // ---------- 3. commit without conversations -> no file ----------
  const three = await setupProject('quiet');
  const boundaryThree = await createBridge({ homeDir: three.home }).appendCommitBoundary({
    repoIdentity: three.repoIdentity,
    commitSha: SHA_A,
    branch: 'main'
  });
  assert.strictEqual(boundaryThree.projection.sealed, false, 'quiet commit does not seal');
  assert.strictEqual(boundaryThree.projection.reason, 'no-conversations', 'skip reason is explicit');
  assert.ok(!fs.existsSync(path.join(sealDirFor(three.store), `${SHA_A}.md`)), 'no file for a conversation-less commit');

  // ---------- 4. idempotency: same sha never rewrites ----------
  const four = await setupProject('idempotent');
  await say({ home: four.home, repo: four.repo, session: 'sess-idem', prompt: '幂等封存' });
  const journalFour = new Journal(path.join(four.store, 'journal'));
  const boundaryFour = {
    commitSha: SHA_A,
    branch: 'main',
    sequence: 2,
    openTurnIdsAtCommit: [],
    previousRepoBoundarySequence: null
  };
  const first = await sealCommitConversations({ journal: journalFour, sealDir: sealDirFor(four.store), boundary: boundaryFour });
  assert.strictEqual(first.sealed, true, 'direct seal call works');
  const before = fs.readFileSync(first.path, 'utf8');
  const second = await sealCommitConversations({ journal: journalFour, sealDir: sealDirFor(four.store), boundary: boundaryFour });
  assert.strictEqual(second.sealed, false, 'second seal is a skip');
  assert.strictEqual(second.reason, 'already-sealed', 'skip reason names the cause');
  assert.strictEqual(fs.readFileSync(second.path, 'utf8'), before, 'existing file is untouched');

  // ---------- 5. unregistered repo -> global journal, no sealing ----------
  const fiveHome = tmpdir('bridge-seal-global-');
  const fiveRepo = path.join(fiveHome, 'work', 'not-imported');
  fs.mkdirSync(fiveRepo, { recursive: true });
  git(fiveRepo, ['init', '-q']);
  git(fiveRepo, ['config', 'user.email', 'seal-test@example.com']);
  git(fiveRepo, ['config', 'user.name', 'Seal Test']);
  const fiveIdentity = (await resolveRepoContext(fiveRepo)).repoIdentity;
  await say({ home: fiveHome, repo: fiveRepo, session: 'sess-global', prompt: '未注册项目的对话' });
  const boundaryFive = await createBridge({ homeDir: fiveHome }).appendCommitBoundary({
    repoIdentity: fiveIdentity,
    commitSha: SHA_A,
    branch: 'main'
  });
  assert.strictEqual(boundaryFive.projection.sealed, false, 'global journal never seals');
  assert.strictEqual(boundaryFive.projection.reason, 'global-journal', 'skip reason explains routing');
  assert.ok(!fs.existsSync(path.join(fiveHome, 'journal', 'commits')), 'no commits dir appears in the global journal');

  // ---------- 6. projection failure never breaks the boundary ----------
  const six = await setupProject('failing');
  await say({ home: six.home, repo: six.repo, session: 'sess-fail', prompt: '封存会失败但边界不能丢' });
  fs.writeFileSync(path.join(six.store, 'commits'), 'a file blocking the seal dir', 'utf8');
  const boundarySix = await createBridge({ homeDir: six.home }).appendCommitBoundary({
    repoIdentity: six.repoIdentity,
    commitSha: SHA_A,
    branch: 'main'
  });
  assert.strictEqual(boundarySix.sequence > 0, true, 'the boundary itself succeeded');
  assert.strictEqual(boundarySix.projection.sealed, false, 'failed projection reports not-sealed');
  assert.ok(boundarySix.projection.error, 'the failure reason is surfaced');
  const sixBoundaries = readJournalLines(path.join(six.store, 'journal')).filter(
    (record) => record.schema === 'git-commit-boundary/v1'
  );
  assert.strictEqual(sixBoundaries.length, 1, 'the boundary is durable in the journal');

  // ---------- 7. rebuild: sealed files are a rebuildable projection ----------
  // Trimmed prefixes are gone from the journal by design (the MD is the
  // archive of record), so rebuild is exercised over an untrimmed span:
  // boundaries appended directly on the journal, no bridge facade, no trim.
  const seven = await setupProject('rebuild');
  await say({ home: seven.home, repo: seven.repo, session: 'sess-rebuild', prompt: '重建测试的提问' });
  await reply({ home: seven.home, repo: seven.repo, session: 'sess-rebuild', message: '重建测试的回复。' });
  const journalSeven = new Journal(path.join(seven.store, 'journal'));
  const b7 = await journalSeven.appendCommitBoundary(seven.repoIdentity, { commitSha: SHA_A, branch: 'main' });
  const seal7 = await sealCommitConversations({
    journal: journalSeven,
    sealDir: sealDirFor(seven.store),
    boundary: {
      commitSha: SHA_A,
      branch: 'main',
      sequence: b7.sequence,
      openTurnIdsAtCommit: b7.openTurnIdsAtCommit,
      previousRepoBoundarySequence: b7.previousRepoBoundarySequence
    }
  });
  assert.strictEqual(seal7.sealed, true, 'direct seal on an untrimmed journal works');
  const rebuiltFile = path.join(sealDirFor(seven.store), `${SHA_A}.md`);
  assert.ok(fs.readFileSync(rebuiltFile, 'utf8').includes('重建测试的提问'), 'sealed file keeps the prompt');
  fs.rmSync(rebuiltFile, { force: true });
  const rebuiltOnce = await rebuildSealedFiles({ journal: journalSeven, sealDir: sealDirFor(seven.store) });
  assert.strictEqual(rebuiltOnce.sealedCount, 1, 'rebuild recreates the sealed file');
  const rebuiltText = fs.readFileSync(rebuiltFile, 'utf8');
  assert.ok(rebuiltText.includes('重建测试的回复。'), 'rebuilt file keeps the reply');
  fs.rmSync(rebuiltFile, { force: true });
  const rebuiltTwice = await rebuildSealedFiles({ journal: journalSeven, sealDir: sealDirFor(seven.store) });
  assert.strictEqual(rebuiltTwice.sealedCount, 1, 'second rebuild also recreates it');
  assert.strictEqual(fs.readFileSync(rebuiltFile, 'utf8'), rebuiltText, 'rebuilds are byte-stable');

  // ---------- 8. CLI smoke: signal injection via the bin entry ----------
  const eight = await setupProject('cli');
  fs.writeFileSync(path.join(eight.repo, 'README.md'), '# cli\n', 'utf8');
  git(eight.repo, ['add', '.']);
  git(eight.repo, ['commit', '-q', '-m', 'init']);
  await say({ home: eight.home, repo: eight.repo, session: 'sess-cli', prompt: 'CLI 注入的提交信号' });
  await reply({ home: eight.home, repo: eight.repo, session: 'sess-cli', message: 'CLI 路径封存成功。' });
  const cliRun = spawnSync(process.execPath, [CLI, '--cwd', eight.repo, '--home', eight.home], {
    encoding: 'utf8',
    windowsHide: true
  });
  assert.strictEqual(cliRun.status, 0, `CLI exits zero (stderr: ${cliRun.stderr})`);
  const cliOut = JSON.parse(cliRun.stdout.trim());
  assert.strictEqual(cliOut.ok, true, 'CLI reports success');
  assert.strictEqual(cliOut.projection.sealed, true, 'CLI injection seals the commit');
  const headSha = git(eight.repo, ['rev-parse', 'HEAD']);
  assert.ok(fs.existsSync(path.join(sealDirFor(eight.store), `${headSha}.md`)), 'sealed file named by the real HEAD sha');

  // ---------- 9. full E2E: real git commit -> post-commit hook -> sealed file ----------
  const nine = await setupProject('hook-e2e');
  fs.writeFileSync(path.join(nine.repo, 'README.md'), '# hook e2e\n', 'utf8');
  git(nine.repo, ['add', '.']);
  git(nine.repo, ['commit', '-q', '-m', 'init']);
  await say({ home: nine.home, repo: nine.repo, session: 'sess-hook', prompt: '真实 git commit 触发的封存' });
  await reply({ home: nine.home, repo: nine.repo, session: 'sess-hook', message: 'post-commit hook 全链路封存成功。' });
  const hookPath = path.join(nine.repo, '.git', 'hooks', 'post-commit');
  const toPosix = (value) => value.replace(/\\/g, '/');
  fs.writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      `"${toPosix(process.execPath)}" "${toPosix(CLI)}" --cwd "${toPosix(nine.repo)}" --home "${toPosix(nine.home)}" >/dev/null 2>&1`,
      'exit 0',
      ''
    ].join('\n'),
    'utf8'
  );
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch (_) {
    // Windows ignores the exec bit; git-for-windows runs hooks through sh.
  }
  fs.writeFileSync(path.join(nine.repo, 'feature.txt'), 'change\n', 'utf8');
  git(nine.repo, ['add', '.']);
  git(nine.repo, ['commit', '-q', '-m', 'feature']); // must not throw: a failed hook never breaks the commit
  const headNine = git(nine.repo, ['rev-parse', 'HEAD']);
  const sealedNine = path.join(sealDirFor(nine.store), `${headNine}.md`);
  assert.ok(fs.existsSync(sealedNine), 'git commit -> hook -> CLI -> sealed file, end to end');
  const textNine = fs.readFileSync(sealedNine, 'utf8');
  assert.ok(textNine.includes('真实 git commit 触发的封存'), 'E2E sealed file keeps the prompt');
  assert.ok(textNine.includes('post-commit hook 全链路封存成功。'), 'E2E sealed file keeps the reply');

  console.log('commit-projection-test: ok');
}

module.exports = main();
