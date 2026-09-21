'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../../core/runtime-home');
const { ConsumerRegistry } = require('../../core/consumer-registry');

const PLUGIN_FILE_NAME = 'ai-coding-event-bridge.js';

function shimPathFor(homeDir) {
  return path.join(homeDir, 'bin', 'bridge-hook.cjs');
}

function pluginSource(shimPath) {
  return `// Installed by @sanqianx/ai-coding-event-bridge. Captures user/assistant
// lifecycle events into the local durable Bridge journal via the stable shim.
// No HTTP endpoint is required; removing the file removes the integration.
const { spawn } = require('child_process');
module.exports = {
  id: 'ai-coding-event-bridge',
  init() {
    return {
      event(event) {
        if (!event || (event.type !== 'user' && event.type !== 'assistant')) return;
        const payload = {
          type: event.type,
          sessionId: event.sessionID || event.sessionId || null,
          turnId: event.turnID || event.turnId || null,
          cwd: event.cwd || process.cwd(),
          text: typeof event.text === 'string' ? event.text : null
        };
        const child = spawn('node', [${JSON.stringify(shimPath)}], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => {});
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      }
    };
  }
};
`;
}

// Registry mutations are host-owned; registerConsumer/unregisterConsumer are
// explicit opt-ins. Uninstall removes only the managed plugin file and never
// touches third-party plugins or the shared runtime home.
async function installOpenCodePlugin({ homeDir, consumerName, consumerMeta = {}, registerConsumer = false, pluginsDir, version } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = pluginsDir || path.join(os.homedir(), '.config', 'opencode', 'plugin');
  const runtime = await ensureRuntimeHome({ homeDir: home, version });
  const registry = new ConsumerRegistry(home);
  if (consumerName && registerConsumer) await registry.registerConsumer(consumerName, consumerMeta);
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, PLUGIN_FILE_NAME);
  fs.writeFileSync(file, pluginSource(shimPathFor(home)));
  return { installed: true, pluginFile: file, runtime };
}

async function statusOpenCodePlugin({ homeDir, pluginsDir } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = pluginsDir || path.join(os.homedir(), '.config', 'opencode', 'plugin');
  const file = path.join(target, PLUGIN_FILE_NAME);
  const exists = fs.existsSync(file);
  let managed = false;
  let thirdPartyFiles = 0;
  if (fs.existsSync(target)) {
    for (const entry of fs.readdirSync(target)) {
      if (entry === PLUGIN_FILE_NAME) continue;
      if (entry.endsWith('.js') || entry.endsWith('.ts')) thirdPartyFiles++;
    }
  }
  if (exists) {
    managed = fs.readFileSync(file, 'utf8').includes('ai-coding-event-bridge');
  }
  return { installed: managed && exists, pluginFile: file, thirdPartyFiles };
}

async function uninstallOpenCodePlugin({ homeDir, consumerName, unregisterConsumer = false, pluginsDir } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = pluginsDir || path.join(os.homedir(), '.config', 'opencode', 'plugin');
  const registry = new ConsumerRegistry(home);
  const file = path.join(target, PLUGIN_FILE_NAME);
  try {
    fs.rmSync(file, { force: true });
  } catch (_) {
    // Already gone.
  }
  let consumerUnregistered = false;
  if (consumerName && unregisterConsumer) {
    await registry.unregisterConsumer(consumerName);
    consumerUnregistered = true;
  }
  return { removed: true, consumerUnregistered, consumers: (await registry.getConsumers()).map(c => c.name) };
}

module.exports = { installOpenCodePlugin, statusOpenCodePlugin, uninstallOpenCodePlugin, PLUGIN_FILE_NAME };
