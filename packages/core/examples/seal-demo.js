'use strict';

/**
 * Standalone demo of per-commit conversation sealing — no knowledge base, no
 * installed clients; everything happens in a temp directory.
 *
 *   node packages/core/examples/seal-demo.js
 *
 * Flow: create a real git repo, register it with a dev-conversations store,
 * capture a conversation through the claude-code hook entry, then signal each
 * commit through the bridge CLI (exactly what a post-commit hook would do).
 * Every sealed file printed below lives in <store>/commits/<sha>.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { addProject } = require('../src/core/project-registry');
const claudeHookEntry = require('../src/connectors/claude-code/hook-entry');

const CLI = path.resolve(__dirname, '..', 'src', 'bin', 'commit-boundary.js');

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).trim();
}

function step(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-seal-demo-'));
  const repo = path.join(root, 'work', 'demo-app');
  const store = path.join(root, 'knowledge', 'demo-app', 'dev-conversations');
  const home = path.join(root, 'bridge-home');
  fs.mkdirSync(repo, { recursive: true });
  step(`create a real git repo at ${repo}`);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'demo@example.com']);
  git(repo, ['config', 'user.name', 'Seal Demo']);

  step('register the project with a dev-conversations store');
  await addProject({ home, path: repo, store });
  console.log(`store: ${store}`);

  const say = (session, prompt) =>
    claudeHookEntry.main({ home, payload: { hookName: 'UserPromptSubmit', session_id: session, cwd: repo, prompt } });
  const reply = (session, message) =>
    claudeHookEntry.main({ home, payload: { hookName: 'Stop', session_id: session, cwd: repo, last_assistant_message: message } });

  const commit = (message) => {
    git(repo, ['commit', '--allow-empty', '-q', '-m', message]);
    // What a post-commit hook would run: signal the just-made commit.
    const run = spawnSync(process.execPath, [CLI, '--cwd', repo, '--home', home], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) throw new Error(`CLI failed: ${run.stderr}`);
    return JSON.parse(run.stdout.trim());
  };

  step('commit 1: no conversations yet -> boundary only, nothing sealed');
  const first = commit('chore: scaffold');
  console.log(`projection: ${JSON.stringify(first.projection)}`);

  step('commit 2: a full turn (ask + reply) belongs to the commit');
  await say('sess-demo', '把首页改成响应式布局');
  await reply('sess-demo', '已把首页改为响应式布局，断点落在 768px 和 1024px。');
  const second = commit('feat: responsive home');
  console.log(`projection: ${JSON.stringify(second.projection)}`);

  step('commit 3: turn still open at commit time -> the ask seals now');
  await say('sess-demo', '先提交，回复稍后到');
  const third = commit('wip: pending reply');
  console.log(`projection: ${JSON.stringify(third.projection)}`);

  step('commit 4: the late reply arrives -> sealed as an unpaired appendix');
  await reply('sess-demo', '这是迟到的回复，commit 3 的文件里没有它。');
  const fourth = commit('docs: late reply');
  console.log(`projection: ${JSON.stringify(fourth.projection)}`);

  const commitsDir = path.join(store, 'commits');
  step(`sealed files in ${commitsDir}`);
  const files = fs.readdirSync(commitsDir).filter((name) => name.endsWith('.md')).sort();
  for (const name of files) {
    const sha = git(repo, ['rev-parse', name.replace(/\.md$/, '')]);
    console.log(`\n----- ${name} (${git(repo, ['log', '-1', '--format=%s', sha])}) -----`);
    console.log(fs.readFileSync(path.join(commitsDir, name), 'utf8').trimEnd());
  }

  step('done');
  console.log(`Everything lives under ${root} (kept for inspection).`);
  console.log('In production the same CLI line is what a managed git hook calls.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
