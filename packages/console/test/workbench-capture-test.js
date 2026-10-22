'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createBridge, projectRegistry } = require('../src/bridge');
const { createConsoleServer } = require('../src/server');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-workbench-'));
  const repo = path.join(root, '中文 项目'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo], { windowsHide: true });
  const project = await projectRegistry.addProject({ home: root, path: repo, store: path.join(root, 'knowledge', 'events') });
  const server = http.createServer(createConsoleServer({ home: root, runtimeToken: 'native-capture-test' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/internal/workbench-event`;
  const body = { projectPath: repo, source: 'claude-code', sessionId: 'native-session-a', turnId: 'native-turn-a', eventKey: 'workbench:a:user', eventType: 'user_prompt', content: '用户原始问题' };
  const post = (event, headers = { Authorization: 'Bearer native-capture-test' }) => fetch(url, { method: 'POST', headers, body: JSON.stringify(event) });
  try {
    assert.equal((await post(body, {})).status, 403);
    assert.equal((await post(body, { Authorization: 'Bearer native-capture-test', Origin: 'http://127.0.0.1' })).status, 403);
    assert.equal((await post({ ...body, projectPath: root })).status, 409);
    const captureResponse = await post(body);
    const captured = await captureResponse.json();
    assert.equal(captureResponse.status, 200, JSON.stringify(captured));
    assert.equal(captured.status, 'captured');
    const duplicate = await (await post(body)).json(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.sequence, captured.sequence);
    if (process.platform === 'win32') {
      const alternateDrive = repo[0] === repo[0].toLowerCase() ? repo[0].toUpperCase() : repo[0].toLowerCase();
      const response = await post({ ...body, projectPath: alternateDrive + repo.slice(1) });
      const result = await response.json();
      assert.equal(response.status, 200, 'drive-letter case must not change project registration: ' + JSON.stringify(result));
      assert.equal(result.duplicate, true);
      assert.equal(result.sequence, captured.sequence);
    }
    assert.equal((await post({ ...body, eventKey: 'workbench:a:assistant', eventType: 'assistant_response', content: '真实最终回答' })).status, 200);
    assert.equal((await post({ ...body, eventKey: 'workbench:a:end', eventType: 'session_end', content: undefined })).status, 200);
    const bridge = createBridge({ homeDir: root });
    const events = await bridge.readEvents({ journalId: project.id });
    assert.equal(events.length, 3); assert.equal((await bridge.readEvents()).length, 0, 'capture uses the registered project journal');
    assert.equal(events[0].content, body.content); assert.equal(events[1].content, '真实最终回答');
    assert.ok(events.every(e => e.repoIdentity.workspaceId === project.id && e.turnId === body.turnId));
    const sessions = await (await fetch(url.replace('/internal/workbench-event', `/sessions?project=${encodeURIComponent(project.id)}`))).json();
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].sessionId, 'native-session-a');
    const restarted = createBridge({ homeDir: root }); assert.equal((await restarted.readEvents({ journalId: project.id })).length, 3);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = main();
