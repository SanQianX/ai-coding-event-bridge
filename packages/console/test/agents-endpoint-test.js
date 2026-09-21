'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const core = require('../src/bridge');
const { createConsoleServer } = require('../src/server');
const { detectAgents } = require('../src/agent-detect');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agents-endpoint-'));

async function startServer() {
  const server = http.createServer(createConsoleServer({ home: HOME }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, payload: await res.json() };
}

async function main() {
  // ---------- detectAgents with explicit config paths (no real user configs) ----------
  const claudeSettings = path.join(HOME, 'fake-claude', 'settings.json');
  const codexConfig = path.join(HOME, 'fake-codex', 'config.toml');
  const opencodePlugins = path.join(HOME, 'fake-opencode', 'plugin');

  // Nothing installed at those paths: detection reports not-found / not-wired.
  let agents = await detectAgents({ claudeSettingsFile: claudeSettings, codexConfigFile: codexConfig, opencodePluginsDir: opencodePlugins, zcodeConfigFile: path.join(HOME, 'fake-zcode', 'config.json') });
  assert.strictEqual(agents.length, 4);
  assert.ok(agents.every((a) => !a.hookInstalled), 'no configs -> no hooks');

  // Wire the managed entries through the real installers (their target dirs must exist).
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  fs.mkdirSync(opencodePlugins, { recursive: true });
  await core.installers.claudeCode.installClaudeCodeHook({ homeDir: HOME, settingsFile: claudeSettings });
  await core.installers.codex.installCodexNotify({ homeDir: HOME, configFile: codexConfig });
  await core.installers.openCode.installOpenCodePlugin({ homeDir: HOME, pluginsDir: opencodePlugins });

  agents = await detectAgents({ claudeSettingsFile: claudeSettings, codexConfigFile: codexConfig, opencodePluginsDir: opencodePlugins, zcodeConfigFile: path.join(HOME, 'fake-zcode', 'config.json') });
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  assert.strictEqual(byId['claude-code'].configFound, true);
  assert.strictEqual(byId['claude-code'].hookInstalled, true, 'managed claude hook detected');
  assert.strictEqual(byId.codex.configFound, true);
  assert.strictEqual(byId.codex.hookInstalled, true, 'managed codex notify detected');
  assert.strictEqual(byId.opencode.hookInstalled, true, 'managed opencode plugin detected');
  assert.strictEqual(byId.zcode.hookInstalled, false, 'zcode untouched when its config path is absent');

  // Fan-out style codex wiring (shim path only inside base64) still counts as hooked.
  const fanoutConfig = path.join(HOME, 'fake-codex', 'fanout.toml');
  fs.writeFileSync(fanoutConfig, 'notify = [ "node", "some-fanout.cjs", "--bridge-base64", "WYliZWFib28=" ]\n', 'utf8');
  agents = await detectAgents({ claudeSettingsFile: claudeSettings, codexConfigFile: fanoutConfig, opencodePluginsDir: opencodePlugins });
  assert.strictEqual(agents.find((a) => a.id === 'codex').hookInstalled, true, 'fanout chain counts as wired');

  // ---------- server endpoints ----------
  const { server, url } = await startServer();
  try {
    const agentsResp = await call(url, 'GET', '/api/system/agents');
    assert.strictEqual(agentsResp.status, 200);
    assert.ok(agentsResp.payload.agents.every((a) => ['claude-code', 'codex', 'opencode', 'zcode'].includes(a.id)));
    const bridge = agentsResp.payload.bridge;
    assert.strictEqual(bridge.home, HOME);
    assert.strictEqual(bridge.coreVersion, core.version);
    // The installer pre-steps already materialized a runtime at the core version.
    assert.strictEqual(bridge.activeRuntimeVersion, core.version);
    assert.strictEqual(bridge.upgradeAvailable, false);
    assert.deepStrictEqual(agentsResp.payload.consumers, []);

    const upgrade = await call(url, 'POST', '/api/system/upgrade-runtime');
    assert.strictEqual(upgrade.status, 200);
    assert.strictEqual(upgrade.payload.activeVersion, core.version, 'runtime stays at the core package version');
    assert.strictEqual(upgrade.payload.action, 'noop-same-version');
    assert.ok(fs.existsSync(path.join(HOME, 'runtime', core.version, 'hook.cjs')), 'new runtime materialized');

    const after = await call(url, 'GET', '/api/system/agents');
    assert.strictEqual(after.payload.bridge.activeRuntimeVersion, core.version);
    assert.strictEqual(after.payload.bridge.upgradeAvailable, false);
    assert.ok(after.payload.bridge.runtimeVersions.includes(core.version));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('agents-endpoint-test: ok');
}

module.exports = main();
