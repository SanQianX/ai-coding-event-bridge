'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  Journal,
  resolveRepoContext,
  projectRegistry
} = require('@sanqianx/ai-coding-event-bridge');
const { createConsoleServer } = require('../src/server');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-console-server-'));
const BASE = {};

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

function event({ identity, projectPath, eventType, role, content, sessionId, turnId, source = 'claude-code' }) {
  return { source, eventType, role, content, sessionId, turnId, repoIdentity: identity, projectPath };
}

async function startServer() {
  const server = http.createServer(createConsoleServer({ home: HOME }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE.url = `http://127.0.0.1:${server.address().port}`;
  return server;
}

async function call(method, pathname, body) {
  const res = await fetch(BASE.url + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = text;
  }
  return { status: res.status, payload, headers: res.headers };
}

async function main() {
  // ---------- fixtures ----------
  const repoA = path.join(HOME, 'work', 'repo-a');
  const repoB = path.join(HOME, 'work', 'repo-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  await git(['init', '-q'], repoA);
  await git(['init', '-q'], repoB);
  const contextA = await resolveRepoContext(repoA);
  const contextB = await resolveRepoContext(repoB);
  assert.ok(contextA.repoIdentity && contextB.repoIdentity, 'fixture repos resolve identities');

  const storeA = path.join(HOME, 'stores', 'repo-a-store');
  const globalJournal = new Journal(path.join(HOME, 'journal'));
  const journalA = new Journal(path.join(storeA, 'journal'));

  // Registered project journal: two turns; turn t1 is open when the boundary lands.
  await journalA.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'user_prompt', role: 'user',
    content: '导入后的第一问', sessionId: 's-a1', turnId: 't-a1'
  }));
  await journalA.appendCommitBoundary(contextA.repoIdentity, {
    commitSha: '9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f90a',
    branch: 'main'
  });
  await journalA.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'assistant_response', role: 'assistant',
    content: '导入后的第一答', sessionId: 's-a1', turnId: 't-a1'
  }));
  await journalA.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'user_prompt', role: 'user',
    content: '导入后的第二问', sessionId: 's-a1', turnId: 't-a2'
  }));
  await journalA.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'assistant_response', role: 'assistant',
    content: '导入后的第二答', sessionId: 's-a1', turnId: 't-a2'
  }));
  await journalA.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'user_prompt', role: 'user',
    content: '导入后的第三问', sessionId: 's-a1', turnId: 't-a3'
  }));
  await journalA.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'assistant_response', role: 'assistant',
    content: '导入后的第三答', sessionId: 's-a1', turnId: 't-a3'
  }));

  // Global journal: one legacy turn for repo A (pre-import history) and one for repo B (auto).
  await globalJournal.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'user_prompt', role: 'user',
    content: '导入前的历史问题', sessionId: 's-a0', turnId: 't-a0'
  }));
  await globalJournal.appendConversationEvent(event({
    identity: contextA.repoIdentity, projectPath: repoA, eventType: 'assistant_response', role: 'assistant',
    content: '导入前的历史回答', sessionId: 's-a0', turnId: 't-a0'
  }));
  await globalJournal.appendConversationEvent(event({
    identity: contextB.repoIdentity, projectPath: repoB, eventType: 'user_prompt', role: 'user',
    content: '未导入项目的问题', sessionId: 's-b1', turnId: 't-b1'
  }));
  await globalJournal.appendConversationEvent(event({
    identity: contextB.repoIdentity, projectPath: repoB, eventType: 'assistant_response', role: 'assistant',
    content: '未导入项目的回答', sessionId: 's-b1', turnId: 't-b1'
  }));

  // Register repo A the way the console does.
  await projectRegistry.addProject({ home: HOME, path: repoA, store: storeA });
  const idA = contextA.repoIdentity.workspaceId;
  const idB = contextB.repoIdentity.workspaceId;

  const server = await startServer();
  try {
    // ---------- health & static ----------
    const health = await call('GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.payload.ok, true);
    assert.strictEqual(health.payload.home, HOME);
    assert.strictEqual(health.payload.registeredProjects, 1);

    const page = await fetch(BASE.url + '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('event-bridge'), 'console page served');

    // ---------- projects: registered + auto, legacy merged into counts ----------
    const projects = await call('GET', '/api/projects');
    assert.strictEqual(projects.status, 200);
    const entryA = projects.payload.projects.find((p) => p.id === idA);
    const entryB = projects.payload.projects.find((p) => p.id === idB);
    assert.ok(entryA, 'registered project listed');
    assert.strictEqual(entryA.auto, false);
    assert.strictEqual(entryA.store, path.join(storeA, 'journal').replace(path.sep + 'journal', ''), 'store reported');
    assert.strictEqual(entryA.turns, 4, 'registered project counts its journal turns plus legacy global history');
    assert.ok(entryB, 'auto-discovered project listed');
    assert.strictEqual(entryB.auto, true);
    assert.strictEqual(entryB.turns, 2, 'auto project counts global conversation events');

    // ---------- dates ----------
    const dates = await call('GET', '/api/dates?project=' + encodeURIComponent(idA));
    assert.strictEqual(dates.status, 200);
    assert.strictEqual(dates.payload.dates.length, 1);
    assert.strictEqual(dates.payload.dates[0].turns, 4);

    // ---------- turns (registered): only the current conversation ----------
    // The journal is a conveyor: the current view serves the turns that live
    // after the last commit boundary; earlier conversations are the archive.
    const turns = await call('GET', '/api/turns?project=' + encodeURIComponent(idA));
    assert.strictEqual(turns.status, 200);
    assert.strictEqual(turns.payload.totalTurns, 2, 'current view = turns after the last boundary');
    const contents = turns.payload.turns.map((t) => t.userEvents[0].content);
    assert.ok(contents.includes('导入后的第二问'), 'post-boundary turn appears');
    assert.ok(contents.includes('导入后的第三问'), 'the newest turn appears');
    assert.ok(!contents.includes('导入前的历史问题'), 'legacy global history is not the current conversation');
    assert.ok(!contents.includes('导入后的第一问'), 'the turn from before the boundary left the current view');
    assert.deepStrictEqual(turns.payload.annotations, {}, 'current view carries no commit annotations');

    // chronological order
    const times = turns.payload.turns.map((t) => t.userEvents[0].capturedAt);
    const sorted = [...times].sort();
    assert.deepStrictEqual(times, sorted, 'current turns are chronologically ordered');

    // ---------- cursor pagination ----------
    const page1 = await call('GET', '/api/turns?project=' + encodeURIComponent(idA) + '&limit=1');
    assert.strictEqual(page1.payload.turns.length, 1);
    assert.ok(page1.payload.nextCursor);
    const page2 = await call('GET', '/api/turns?project=' + encodeURIComponent(idA) + '&limit=1&cursor=' + encodeURIComponent(page1.payload.nextCursor));
    assert.strictEqual(page2.payload.turns.length, 1);
    assert.strictEqual(page2.payload.nextCursor, null);
    const badCursor = await call('GET', '/api/turns?project=' + encodeURIComponent(idA) + '&cursor=not-a-cursor');
    assert.strictEqual(badCursor.status, 400);

    // ---------- auto project & search ----------
    const turnsB = await call('GET', '/api/turns?project=' + encodeURIComponent(idB));
    assert.strictEqual(turnsB.payload.totalTurns, 1);
    const search = await call('GET', '/api/search?q=' + encodeURIComponent('历史问题') + '&project=' + encodeURIComponent(idA));
    assert.strictEqual(search.status, 200);
    assert.strictEqual(search.payload.matches.length, 1);

    const missing = await call('GET', '/api/turns?project=sha256:deadbeef');
    assert.strictEqual(missing.status, 404);

    // ---------- commit documents: list + lazy single-doc fetch ----------
    const commitsDir = path.join(storeA, 'commits');
    fs.mkdirSync(commitsDir, { recursive: true });
    const docSha = '9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f90a';
    fs.writeFileSync(path.join(commitsDir, `${docSha}.md`), [
      '---',
      `commitSha: ${docSha}`,
      "subject: 'feat: sealed doc listing'",
      'branch: main',
      "committedAt: '2026-09-19T22:35:00Z'",
      'turnCount: 2',
      'unpairedEventCount: 0',
      '---',
      '',
      '## Turn 1 — 2026-09-19 22:33 (t-a1, exact)',
      '',
      '### 用户',
      '',
      '```',
      '导入后的第一问',
      '```',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(commitsDir, '2026-01-02-uncommitted-9.md'), [
      '---',
      'subject: 未提交的对话',
      'uncommitted: true',
      "sealedAt: '2026-01-02T10:00:00Z'",
      'turnCount: 1',
      '---',
      ''
    ].join('\n'));

    const commitList = await call('GET', '/api/commits?project=' + encodeURIComponent(idA));
    assert.strictEqual(commitList.status, 200);
    assert.strictEqual(commitList.payload.commits.length, 2, 'both sealed docs are listed');
    const listed = commitList.payload.commits[0];
    assert.strictEqual(listed.subject, 'feat: sealed doc listing', 'frontmatter subject surfaces (newest first)');
    assert.strictEqual(listed.sha, docSha);
    assert.strictEqual(listed.uncommitted, false);
    const listedFuse = commitList.payload.commits[1];
    assert.strictEqual(listedFuse.uncommitted, true, 'uncommitted docs are flagged');
    assert.strictEqual(listedFuse.subject, '未提交的对话');

    const doc = await fetch(BASE.url + '/api/commits/' + docSha + '.md?project=' + encodeURIComponent(idA));
    assert.strictEqual(doc.status, 200);
    assert.match(doc.headers.get('content-type') || '', /text\/markdown/);
    assert.ok((await doc.text()).includes('导入后的第一问'), 'document body serves');

    const docMissing = await call('GET', '/api/commits/' + 'f'.repeat(40) + '.md?project=' + encodeURIComponent(idA));
    assert.strictEqual(docMissing.status, 404, 'unknown document 404s');
    const docNoProject = await call('GET', '/api/commits/' + docSha + '.md');
    assert.strictEqual(docNoProject.status, 404, 'document fetch without project 404s');
    const docInvalid = await call('GET', '/api/commits/evil_name.md?project=' + encodeURIComponent(idA));
    assert.strictEqual(docInvalid.status, 400, 'names the sealer could not produce are rejected');
    const commitsB = await call('GET', '/api/commits?project=' + encodeURIComponent(idB));
    assert.strictEqual(commitsB.payload.commits.length, 0, 'auto projects have no archive');
    const docB = await call('GET', '/api/commits/' + docSha + '.md?project=' + encodeURIComponent(idB));
    assert.strictEqual(docB.status, 404, 'auto projects cannot fetch documents');

    // ---------- import validation ----------
    const noDir = await call('POST', '/api/projects', { path: path.join(HOME, 'missing') });
    assert.strictEqual(noDir.status, 400);
    const plainDir = path.join(HOME, 'work', 'plain');
    fs.mkdirSync(plainDir, { recursive: true });
    const notGit = await call('POST', '/api/projects', { path: plainDir });
    assert.strictEqual(notGit.status, 422);
    assert.strictEqual(notGit.payload.error.code, 'PROJECT_NOT_GIT');
    const duplicate = await call('POST', '/api/projects', { path: repoA });
    assert.strictEqual(duplicate.status, 409);

    const repoC = path.join(HOME, 'work', 'repo-c');
    fs.mkdirSync(repoC, { recursive: true });
    await git(['init', '-q'], repoC);
    const imported = await call('POST', '/api/projects', { path: repoC });
    assert.strictEqual(imported.status, 201);
    assert.strictEqual(imported.payload.project.auto, false);
    assert.ok(fs.existsSync(path.join(imported.payload.project.store, 'journal')), 'default store journal materialized');

    // ---------- pick-folder graceful when disabled ----------
    const previous = process.env.BRIDGE_CONSOLE_PICK_FOLDER;
    process.env.BRIDGE_CONSOLE_PICK_FOLDER = '0';
    try {
      const pick = await call('GET', '/api/system/pick-folder');
      assert.strictEqual(pick.status, 501);
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_CONSOLE_PICK_FOLDER;
      else process.env.BRIDGE_CONSOLE_PICK_FOLDER = previous;
    }

    // ---------- unregister keeps data and falls back to auto discovery ----------
    const removed = await call('DELETE', '/api/projects?id=' + encodeURIComponent(idA));
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.payload.removed.id, idA);
    assert.ok(fs.existsSync(path.join(storeA, 'journal', 'events.jsonl')), 'unregister keeps project data on disk');
    const after = await call('GET', '/api/projects');
    const autoA = after.payload.projects.find((p) => p.id === idA);
    assert.ok(autoA && autoA.auto, 'unregistered project degrades to auto (legacy global events)');
    const turnsAfter = await call('GET', '/api/turns?project=' + encodeURIComponent(idA));
    assert.strictEqual(turnsAfter.payload.totalTurns, 1, 'only the legacy global turn remains visible after unregister');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('console-server-test: ok');
}

module.exports = main();
