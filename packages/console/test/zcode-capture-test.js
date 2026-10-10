'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('../src/bridge');
const { detectAgents } = require('../src/agent-detect');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-zcode-real-hook-'));
  const home = path.join(temp, '事件 空格');
  const configFile = path.join(temp, '用户', '.zcode', 'cli', 'config.json');
  const installer = core.installers.zcode;
  try {
    const installed = await installer.installZcodeHook({ homeDir: home, configFile });
    assert(fs.existsSync(configFile), 'first install creates missing parent directories');
    const config = JSON.parse(fs.readFileSync(configFile));
    const hook = config.hooks.events.UserPromptSubmit[0].hooks[0];
    assert.deepEqual(hook.args, [installed.runtime.shimPath, '--source', 'zcode']);
    const env = { ...process.env };
    delete env.AI_CODING_EVENT_BRIDGE_HOME;
    delete env.AI_CODING_EVENT_BRIDGE_CAPTURE;
    const runHook = payload => {
      const result = spawnSync(process.execPath, hook.args, { encoding: 'utf8', input: JSON.stringify(payload), env, timeout: 15000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    };
    runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'zcode-session-a', cwd: temp, prompt: '验证外部 ZCode 采集', turnId: 'zcode-turn-a' });
    runHook({ hook_event_name: 'Stop', session_id: 'zcode-session-a', cwd: temp, last_assistant_message: '真实 Hook 子进程已写入。', turnId: 'zcode-turn-a' });
    const journal = new core.Journal(path.join(home, 'journal'));
    const events = await journal.readEvents({});
    assert.equal(events.length, 2, 'external Agent needs no inherited shell home variable');
    assert(events.every(event => event.source === 'zcode'), 'ZCode events must never masquerade as Claude Code');
    assert.equal(events[0].content, '验证外部 ZCode 采集');
    assert.equal(events[1].content, '真实 Hook 子进程已写入。');
    assert.equal(events[0].turnId, events[1].turnId);
    const detect = () => detectAgents({ homeDir: home, zcodeConfigFile: configFile, claudeSettingsFile: path.join(temp, 'missing-claude'), codexConfigFile: path.join(temp, 'missing-codex'), opencodePluginsDir: path.join(temp, 'missing-open') });
    assert((await detect()).find(agent => agent.id === 'zcode').managed);
    config.hooks.enabled = false;
    fs.writeFileSync(configFile, JSON.stringify(config));
    assert.equal((await detect()).find(agent => agent.id === 'zcode').hookInstalled, false, 'disabled config is not wired just because shim text is present');

    // Repair older entries in place; preserve unrelated hooks even within a group.
    const thirdParty = { type: 'process', command: 'other-tool', args: ['keep'] };
    config.hooks.events.UserPromptSubmit[0].hooks.push(thirdParty);
    config.hooks.events.Stop[0].hooks[0].args = [installed.runtime.shimPath];
    fs.writeFileSync(configFile, JSON.stringify(config));
    await installer.repairZcodeHook({ homeDir: home, configFile });
    const repaired = JSON.parse(fs.readFileSync(configFile));
    assert.equal(repaired.hooks.events.Stop.length, 1);
    assert.deepEqual(repaired.hooks.events.Stop[0].hooks[0].args.slice(-2), ['--source', 'zcode']);
    assert((await detect()).find(agent => agent.id === 'zcode').hookInstalled);
    env.AI_CODING_EVENT_BRIDGE_CAPTURE = '0';
    runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'internal-session', cwd: temp, prompt: 'internal' });
    assert.equal((await journal.readEvents({})).length, 2, 'internal SDK capture-disable remains effective');
    await installer.uninstallZcodeHook({ homeDir: home, configFile });
    const removed = JSON.parse(fs.readFileSync(configFile));
    assert.deepEqual(removed.hooks.events.UserPromptSubmit[0].hooks, [thirdParty]);
    await installer.uninstallZcodeHook({ homeDir: home, configFile });
    const absent = path.join(temp, 'missing', 'config.json');
    await installer.uninstallZcodeHook({ homeDir: home, configFile: absent });
    assert(!fs.existsSync(absent), 'removing a missing connector is a read-only no-op');
    console.log('zcode-capture-test PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
module.exports = main();
