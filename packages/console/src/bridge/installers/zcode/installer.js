'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../../core/runtime-home');
const { ConsumerRegistry } = require('../../core/consumer-registry');
const { readJsonIfExists, writeJsonAtomicSync } = require('../../core/fs-utils');

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop'];

// ZCode configuration-file hooks are disabled by default: the runner only
// exists when hooks.enabled is true (or a plugin contributes hooks, which we
// must not rely on). The managed entries therefore force it on; uninstall
// leaves the flag alone because third-party config hooks may depend on it.
class InstallerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallerError';
  }
}

function shimPathFor(homeDir) {
  return path.join(homeDir, 'bin', 'bridge-hook.cjs');
}

// process hooks (argument vector, no shell) are the portable form; bare
// `node` survives Node upgrades, unlike a baked-in absolute executable path.
function managedHook(shimPath) {
  return { type: 'process', command: 'node', args: [shimPath, '--source', 'zcode'], timeoutMs: 15000 };
}

function isManagedHook(hook, shimPath) {
  if (!hook || typeof hook !== 'object') return false;
  if (hook.type === 'process') {
    return Array.isArray(hook.args) && hook.args.some((arg) => typeof arg === 'string' && arg.includes(shimPath));
  }
  return typeof hook.command === 'string' && hook.command.includes(shimPath);
}

function readConfig(configFile) {
  const config = readJsonIfExists(configFile);
  if (config === null) {
    if (fs.existsSync(configFile)) {
      throw new InstallerError(`config file is not valid JSON: ${configFile}`);
    }
    return {};
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new InstallerError(`config file must contain a JSON object: ${configFile}`);
  }
  return config;
}

function eventsOf(config) {
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  if (!config.hooks.events || typeof config.hooks.events !== 'object' || Array.isArray(config.hooks.events)) {
    config.hooks.events = {};
  }
  return config.hooks.events;
}

function upsertManagedEntries(config, shimPath) {
  const events = eventsOf(config);
  const changed = [];
  for (const eventName of HOOK_EVENTS) {
    if (!Array.isArray(events[eventName])) {
      events[eventName] = [];
    }
    let alreadyManaged = false;
    for (const group of events[eventName]) {
      if (!group || !Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.map(hook => {
        if (!isManagedHook(hook, shimPath)) return hook;
        alreadyManaged = true;
        return managedHook(shimPath);
      });
    }
    if (alreadyManaged) continue;
    events[eventName].push({ hooks: [managedHook(shimPath)] });
    changed.push(eventName);
  }
  if (config.hooks.enabled !== true) {
    config.hooks.enabled = true;
  }
  return changed;
}

function removeManagedEntries(config, shimPath) {
  const removed = [];
  for (const eventName of Object.keys(config.hooks.events)) {
    const groups = config.hooks.events[eventName];
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const kept = groups.map(group => {
      if (!group || !Array.isArray(group.hooks)) return group;
      const hooks = group.hooks.filter(hook => !isManagedHook(hook, shimPath));
      if (hooks.length === group.hooks.length) return group;
      changed = true;
      return hooks.length ? { ...group, hooks } : null;
    }).filter(group => group !== null);
    if (changed) removed.push(eventName);
    if (kept.length === 0) {
      delete config.hooks.events[eventName];
    } else {
      config.hooks.events[eventName] = kept;
    }
  }
  return removed;
}

// Host-level consumer registration is owned by the host; the installer mutates
// the registry only on explicit opt-in (same contract as the other connectors).
async function installZcodeHook({ homeDir, consumerName, consumerMeta = {}, registerConsumer = false, configFile, version } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = configFile || path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  const runtime = await ensureRuntimeHome({ homeDir: home, version });
  if (runtime.conflict) throw new InstallerError('Bridge 运行版本冲突，未修改 ZCode 配置。');
  const registry = new ConsumerRegistry(home);
  if (consumerName && registerConsumer) {
    await registry.registerConsumer(consumerName, consumerMeta);
  }
  const config = readConfig(target);
  const added = upsertManagedEntries(config, shimPathFor(home));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJsonAtomicSync(target, config);
  return { added, configFile: target, runtime, consumers: (await registry.getConsumers()).map((c) => c.name) };
}

async function statusZcodeHook({ homeDir, configFile } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = configFile || path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  const config = readConfig(target);
  const events = config.hooks && typeof config.hooks === 'object' ? config.hooks.events || {} : {};
  const shimPath = shimPathFor(home);
  const managedEvents = [];
  let thirdPartyCount = 0;
  for (const eventName of Object.keys(events)) {
    const groups = events[eventName];
    if (!Array.isArray(groups)) continue;
    let hasManaged = false;
    for (const group of groups) {
      for (const hook of (group && group.hooks) || []) {
        if (isManagedHook(hook, shimPath)) {
          hasManaged = true;
        } else {
          thirdPartyCount++;
        }
      }
    }
    if (hasManaged) managedEvents.push(eventName);
  }
  const registry = new ConsumerRegistry(home);
  return {
    installed:
      HOOK_EVENTS.every((eventName) => managedEvents.includes(eventName)) &&
      Boolean(config.hooks && config.hooks.enabled),
    managedEvents,
    thirdPartyCount,
    consumers: (await registry.getConsumers()).map((c) => c.name)
  };
}

async function repairZcodeHook({ homeDir, consumerName, consumerMeta = {}, registerConsumer = false, configFile, version } = {}) {
  return installZcodeHook({ homeDir, consumerName, consumerMeta, registerConsumer, configFile, version });
}

async function uninstallZcodeHook({ homeDir, consumerName, unregisterConsumer = false, configFile } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = configFile || path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  const registry = new ConsumerRegistry(home);
  const config = readConfig(target);
  const removed = config.hooks && config.hooks.events ? removeManagedEntries(config, shimPathFor(home)) : [];
  if (removed.length) writeJsonAtomicSync(target, config);
  let consumerUnregistered = false;
  if (consumerName && unregisterConsumer) {
    await registry.unregisterConsumer(consumerName);
    consumerUnregistered = true;
  }
  return {
    removed: true,
    removedEvents: removed,
    configFile: target,
    consumerUnregistered,
    consumers: (await registry.getConsumers()).map((c) => c.name)
  };
}

module.exports = {
  HOOK_EVENTS,
  InstallerError,
  installZcodeHook,
  statusZcodeHook,
  repairZcodeHook,
  uninstallZcodeHook,
  managedHook,
  isManagedHook
};
