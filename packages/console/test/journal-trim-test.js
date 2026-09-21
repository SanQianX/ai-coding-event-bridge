'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { resolveRepoContext } = require('../src/bridge/core/repo-context');
const { addProject } = require('../src/bridge/core/project-registry');
const { createBridge } = require('../src/bridge/core/bridge');
const { Journal } = require('../src/bridge/core/journal');
const { sealDirFor, sealCommitConversations, sealUncommittedTail, reconcileTrim } = require('../src/bridge/core/commit-projection');
const claudeHookEntry = require('../src/bridge/connectors/claude-code/hook-entry');

const CLI = path.resolve(__dirname, '..', 'src', 'bridge', 'bin', 'commit-boundary.js');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).trim();
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJournalLines(journalDir) {
  try {
    return fs
      .readFileSync(path.join(journalDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function readState(journalDir) {
  return JSON.parse(fs.readFileSync(path.join(journalDir, 'state.json'), 'utf8'));
}

async function setupProject(name) {
  const home = tmpdir('bridge-trim-home-');
  const repo = path.join(home, 'work', name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'trim-test@example.com']);
  git(repo, ['config', 'user.name', 'Trim Test']);
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
  // ---------- 1. seal -> trim: the journal becomes a conveyor ----------
  const one = await setupProject('trim-basic');
  await say({ home: one.home, repo: one.repo, session: 's1', prompt: '裁剪基础测试的提问' });
  await reply({ home: one.home, repo: one.repo, session: 's1', message: '裁剪基础测试的回复。' });
  const boundaryOne = await createBridge({ homeDir: one.home }).appendCommitBoundary({
    repoIdentity: one.repoIdentity,
    commitSha: SHA_A,
    branch: 'main',
    subject: 'chore: trim basics'
  });
  assert.strictEqual(boundaryOne.projection.sealed, true, 'seal ran');
  assert.strictEqual(boundaryOne.projection.trimmedThrough, boundaryOne.sequence, 'trim reported through the boundary');
  const fileOne = path.join(sealDirFor(one.store), `${SHA_A}.md`);
  assert.ok(fs.existsSync(fileOne), 'the archive file exists');
  assert.ok(fs.readFileSync(fileOne, 'utf8').includes('chore: trim basics'), 'frontmatter carries the commit subject');
  assert.strictEqual(readJournalLines(path.join(one.store, 'journal')).length, 0, 'journal keeps only the unsealed tail (empty here)');
  const stateOne = readState(path.join(one.store, 'journal'));
  assert.strictEqual(stateOne.firstSequence, boundaryOne.sequence + 1, 'firstSequence advanced past the boundary');
  assert.strictEqual(Object.keys(stateOne.openTurns).length, 0, 'trimmed turns leave the open-turn state');

  // ---------- 2. late reply after trim -> orphan -> next seal's appendix ----------
  const two = await setupProject('trim-straddle');
  const bridgeTwo = createBridge({ homeDir: two.home });
  await say({ home: two.home, repo: two.repo, session: 's2', prompt: '先提交，回复稍后到（裁剪版）' });
  const bA = await bridgeTwo.appendCommitBoundary({ repoIdentity: two.repoIdentity, commitSha: SHA_A, branch: 'main' });
  assert.strictEqual(bA.projection.trimmedThrough, bA.sequence, 'first boundary trimmed');
  assert.ok(fs.readFileSync(path.join(sealDirFor(two.store), `${SHA_A}.md`), 'utf8').includes('先提交，回复稍后到（裁剪版）'), 'prompt sealed before trim');
  await reply({ home: two.home, repo: two.repo, session: 's2', message: '裁剪后才到的回复' });
  const replyRecord = readJournalLines(path.join(two.store, 'journal')).find((r) => r.eventType === 'assistant_response');
  assert.ok(replyRecord, 'the late reply lives in the journal tail');
  assert.strictEqual(replyRecord.turnId, null, 'with its turn trimmed it lands as an orphan (no open turn to bind)');
  const bB = await bridgeTwo.appendCommitBoundary({ repoIdentity: two.repoIdentity, commitSha: SHA_B, branch: 'main' });
  assert.strictEqual(bB.previousRepoBoundarySequence, bA.sequence, 'boundary chain survives the trim');
  const fileB = fs.readFileSync(path.join(sealDirFor(two.store), `${SHA_B}.md`), 'utf8');
  assert.ok(fileB.includes('未配对事件'), 'late reply seals as an unpaired appendix');
  assert.ok(fileB.includes('裁剪后才到的回复'), 'the reply body is never dropped');
  assert.strictEqual(readJournalLines(path.join(two.store, 'journal')).length, 0, 'second trim empties the tail');

  // ---------- 3. seal failure -> boundary durable, no trim ----------
  const three = await setupProject('trim-fail');
  await say({ home: three.home, repo: three.repo, session: 's3', prompt: '封存失败时裁剪不能发生' });
  fs.writeFileSync(path.join(three.store, 'commits'), 'blocking file', 'utf8');
  const boundaryThree = await createBridge({ homeDir: three.home }).appendCommitBoundary({
    repoIdentity: three.repoIdentity,
    commitSha: SHA_A,
    branch: 'main'
  });
  assert.strictEqual(boundaryThree.projection.sealed, false, 'seal failed');
  assert.ok(boundaryThree.projection.error, 'failure surfaced');
  assert.strictEqual(boundaryThree.projection.trimmedThrough, undefined, 'no trim on failure');
  assert.ok(readJournalLines(path.join(three.store, 'journal')).length >= 2, 'events and boundary stay durable');

  // ---------- 4. reconcileTrim: heal the crash window between seal and trim ----------
  const four = await setupProject('trim-reconcile');
  await say({ home: four.home, repo: four.repo, session: 's4', prompt: '对账测试的提问' });
  await reply({ home: four.home, repo: four.repo, session: 's4', message: '对账测试的回复。' });
  const journalFour = new Journal(path.join(four.store, 'journal'));
  const b4 = await journalFour.appendCommitBoundary(four.repoIdentity, { commitSha: SHA_A, branch: 'main' }); // direct: no bridge, no trim
  const seal4 = await sealCommitConversations({
    journal: journalFour,
    sealDir: sealDirFor(four.store),
    boundary: { commitSha: SHA_A, branch: 'main', sequence: b4.sequence, openTurnIdsAtCommit: b4.openTurnIdsAtCommit, previousRepoBoundarySequence: b4.previousRepoBoundarySequence }
  });
  assert.strictEqual(seal4.sealed, true, 'sealed without trimming (simulated crash after seal)');
  assert.ok(readJournalLines(path.join(four.store, 'journal')).length >= 3, 'journal still full before reconciliation');
  const healed = await reconcileTrim({ journal: journalFour, sealDir: sealDirFor(four.store) });
  assert.strictEqual(healed.trimmedThrough, b4.sequence, 'reconciliation trims through the sealed boundary');
  assert.strictEqual(healed.reason, 'trimmed', 'trim actually happened');
  const again = await reconcileTrim({ journal: journalFour, sealDir: sealDirFor(four.store) });
  assert.strictEqual(again.reason, 'no-sealed-boundary', 'after trimming, the boundary record is gone and reconciliation is a no-op');
  const nothing = await reconcileTrim({ journal: new Journal(path.join(four.home, 'journal')), sealDir: sealDirFor(four.store) });
  assert.strictEqual(nothing.reason, 'no-sealed-boundary', 'unsealed journals are left alone');

  // ---------- 5. age fuse: never-committed tail gets an uncommitted archive ----------
  const five = await setupProject('trim-fuse');
  const journalFive = new Journal(path.join(five.store, 'journal'));
  await journalFive.appendConversationEvent({
    source: 'claude-code',
    eventType: 'user_prompt',
    role: 'user',
    content: '很久以前的未提交提问',
    sessionId: 's5',
    turnId: 'turn-fuse',
    repoIdentity: five.repoIdentity,
    capturedAt: '2026-08-01T10:00:00.000Z'
  });
  await journalFive.appendConversationEvent({
    source: 'claude-code',
    eventType: 'assistant_response',
    role: 'assistant',
    content: '很久以前的未提交回复。',
    sessionId: 's5',
    turnId: 'turn-fuse',
    repoIdentity: five.repoIdentity,
    capturedAt: '2026-08-01T10:01:00.000Z'
  });
  const tooYoung = await sealUncommittedTail({ journal: journalFive, sealDir: sealDirFor(five.store), maxAgeDays: 30, now: Date.parse('2026-08-10T00:00:00Z') });
  assert.strictEqual(tooYoung.sealed, false, 'within the age window nothing fires');
  assert.strictEqual(tooYoung.reason, 'too-young', 'reason names the cause');
  const fired = await sealUncommittedTail({ journal: journalFive, sealDir: sealDirFor(five.store), maxAgeDays: 30, now: Date.parse('2026-09-20T00:00:00Z') });
  assert.strictEqual(fired.sealed, true, 'over-age tail seals');
  const fuseFile = fired.path;
  assert.ok(/^2026-08-01-uncommitted-\d+\.md$/.test(path.basename(fired.path)), `uncommitted filename carries the conversation day + boundary: ${path.basename(fired.path)}`);
  const fuseText = fs.readFileSync(fuseFile, 'utf8');
  assert.ok(fuseText.includes('uncommitted: true'), 'frontmatter marks the doc uncommitted');
  assert.ok(fuseText.includes('subject: 未提交的对话'), 'subject is user-facing');
  assert.ok(fuseText.includes('很久以前的未提交提问'), 'old prompt archived');
  assert.ok(typeof fired.trimmedThrough === 'number', 'journal trimmed after the fuse');
  assert.strictEqual(readJournalLines(path.join(five.store, 'journal')).length, 0, 'tail is gone from the journal');
  const idle = await sealUncommittedTail({ journal: journalFive, sealDir: sealDirFor(five.store), maxAgeDays: 30, now: Date.parse('2026-10-01T00:00:00Z') });
  assert.strictEqual(idle.reason, 'nothing-after-last-boundary', 'no new events -> no-op on the next run');

  // ---------- 6. subject end to end through the CLI ----------
  const six = await setupProject('trim-cli');
  fs.writeFileSync(path.join(six.repo, 'feature.txt'), 'x\n', 'utf8');
  git(six.repo, ['add', '.']);
  git(six.repo, ['commit', '-q', '-m', 'feat: cli subject passthrough']);
  await say({ home: six.home, repo: six.repo, session: 's6', prompt: 'CLI subject 链路的提问' });
  await reply({ home: six.home, repo: six.repo, session: 's6', message: 'CLI subject 链路的回复。' });
  const cli = spawnSync(process.execPath, [CLI, '--cwd', six.repo, '--home', six.home], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(cli.status, 0, `CLI exits zero (stderr: ${cli.stderr})`);
  const cliOut = JSON.parse(cli.stdout.trim());
  assert.strictEqual(cliOut.projection.sealed, true, 'CLI seals');
  assert.strictEqual(cliOut.projection.trimmedThrough, cliOut.sequence, 'CLI trims');
  const headSha = git(six.repo, ['rev-parse', 'HEAD']);
  const cliFile = fs.readFileSync(path.join(sealDirFor(six.store), `${headSha}.md`), 'utf8');
  assert.ok(cliFile.includes('feat: cli subject passthrough'), 'subject flows git -> CLI -> boundary -> frontmatter');
  assert.ok(cliFile.includes('CLI subject 链路的提问'), 'content sealed');

  console.log('journal-trim-test: ok');
}

module.exports = main();
