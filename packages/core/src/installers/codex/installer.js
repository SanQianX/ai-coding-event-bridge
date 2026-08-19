'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../../core/runtime-home');
const { ConsumerRegistry } = require('../../core/consumer-registry');

class InstallerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallerError';
  }
}

function shimPathFor(homeDir) {
  return path.join(homeDir, 'bin', 'bridge-hook.cjs');
}

function managedNotifyCommand(shimPath) {
  return `["node", "${shimPath}"]`;
}

function isManagedNotifyLine(line, shimPath) {
  return /^\s*notify\s*=/.test(line) && line.includes(shimPath);
}

/**
 * Codex config.toml merge. The notify entry is a single TOML array; we install
 * ours only when the key is absent, and refuse to displace a third-party
 * notifier (report conflict instead). Uninstall removes the entry only when it
 * is Bridge-managed.
 */
// Registry mutations are host-owned; registerConsumer/unregisterConsumer are
// explicit opt-ins. Uninstall never deletes the shared runtime home.
async function installCodexNotify({ homeDir, consumerName, consumerMeta = {}, registerConsumer = false, configFile, version } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = configFile || path.join(os.homedir(), '.codex', 'config.toml');
  const runtime = await ensureRuntimeHome({ homeDir: home, version });
  const registry = new ConsumerRegistry(home);
  if (consumerName && registerConsumer) await registry.registerConsumer(consumerName, consumerMeta);

  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  let notifyIndex = -1;
  let alreadyManaged = false;
  let thirdParty = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*notify\s*=/.test(lines[i])) {
      notifyIndex = i;
      if (isManagedNotifyLine(lines[i], shimPathFor(home))) alreadyManaged = true;
      else thirdParty = true;
      break;
    }
  }
  if (thirdParty && !alreadyManaged) {
    return {
      installed: false,
      conflict: true,
      reason: 'third-party-notify-present',
      settingsFile: target,
      runtime
    };
  }
  if (!alreadyManaged) {
    const entry = `notify = ${managedNotifyCommand(shimPathFor(home))}`;
    if (notifyIndex === -1) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', entry);
    } else {
      lines[notifyIndex] = entry;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lines.join('\n').replace(/^\n/, '') + '\n');
  }
  return { installed: true, conflict: false, settingsFile: target, runtime };
}

async function statusCodexNotify({ homeDir, configFile } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = configFile || path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(target)) return { installed: false, thirdParty: false };
  const line = fs.readFileSync(target, 'utf8').split(/\r?\n/).find(l => /^\s*notify\s*=/.test(l));
  if (!line) return { installed: false, thirdParty: false };
  return { installed: isManagedNotifyLine(line, shimPathFor(home)), thirdParty: !isManagedNotifyLine(line, shimPathFor(home)) };
}

async function uninstallCodexNotify({ homeDir, consumerName, unregisterConsumer = false, configFile } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = configFile || path.join(os.homedir(), '.codex', 'config.toml');
  const registry = new ConsumerRegistry(home);
  if (fs.existsSync(target)) {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
    const kept = lines.filter(line => !(isManagedNotifyLine(line, shimPathFor(home))));
    if (kept.length !== lines.length) {
      fs.writeFileSync(target, kept.join('\n').replace(/\n{3,}/g, '\n\n'));
    }
  }
  let consumerUnregistered = false;
  if (consumerName && unregisterConsumer) {
    await registry.unregisterConsumer(consumerName);
    consumerUnregistered = true;
  }
  return { removed: true, consumerUnregistered, consumers: (await registry.getConsumers()).map(c => c.name) };
}

module.exports = {
  InstallerError,
  installCodexNotify,
  statusCodexNotify,
  uninstallCodexNotify,
  managedNotifyCommand,
  isManagedNotifyLine
};
