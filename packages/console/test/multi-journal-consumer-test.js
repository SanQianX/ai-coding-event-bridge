'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createBridge, projectRegistry, resolveRepoContext } = require('../src/bridge');
const { createConsoleServer } = require('../src/server');

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-multi-journal-'));
  const bridge = createBridge({ homeDir: home });
  await bridge.registerConsumer('knowledge-engine', { journals: ['*'] });
  const projects = [];
  for (const name of ['中文项目 A', 'project B']) {
    const repo = path.join(home, name);
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo], { windowsHide: true });
    const project = await projectRegistry.addProject({ home, path: repo, store: path.join(home, 'stores', name) });
    const { repoIdentity } = await resolveRepoContext(repo);
    await require('../src/bridge').journalFor(home, repoIdentity).appendEvent({ source: 'claude-code', eventType: 'user_prompt', role: 'user', content: name, repoIdentity, turnId: 't1' });
    const boundary = await bridge.appendCommitBoundary({ repoIdentity, commitSha: (projects.length ? 'b' : 'a').repeat(40), subject: name });
    assert.equal(boundary.journalId, project.id);
    assert.equal(boundary.projection.sealed, true);
    assert.equal((await bridge.readEvents({ journalId: project.id })).length, 2, 'archive is not an ACK');
    projects.push({ ...project, sequence: boundary.sequence });
  }
  await bridge.ackConsumerCursor('knowledge-engine', projects[0].sequence, { journalId: projects[0].id });
  assert.equal((await bridge.getConsumer('knowledge-engine')).ack, 0, 'global cursor remains isolated');
  assert.equal((await bridge.compact({ journalId: projects[1].id })).removedCount, 0, 'A ACK cannot trim B');
  await assert.rejects(bridge.ackConsumerCursor('knowledge-engine', 99, { journalId: projects[1].id }), { code: 'ACK_OUT_OF_RANGE' });
  await assert.rejects(bridge.readEvents({ journalId: '../../outside' }), { code: 'JOURNAL_NOT_FOUND' });

  const server = http.createServer(createConsoleServer({ home }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/journal/events?journalId=${encodeURIComponent(projects[1].id)}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).events.length, 2, 'startup maintenance retains unseen boundary');
    const restarted = createBridge({ homeDir: home });
    assert.equal((await restarted.getConsumer('knowledge-engine')).cursors[projects[0].id], projects[0].sequence);
    const ack = await fetch(`${base}/api/consumers/ack`, { method: 'POST', body: JSON.stringify({ name: 'knowledge-engine', journalId: projects[1].id, sequence: projects[1].sequence }) });
    assert.equal(ack.status, 200);
    await restarted.compact({ journalId: projects[1].id });
    assert.equal((await restarted.readEvents({ journalId: projects[1].id })).length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('multi-journal-consumer-test PASS');
}

module.exports = main();
