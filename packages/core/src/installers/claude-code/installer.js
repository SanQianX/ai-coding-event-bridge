'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../../core/runtime-home');
const { ConsumerRegistry } = require('../../core/consumer-registry');
const { readJsonIfExists, writeJsonAtomicSync } = require('../../core/fs-utils');

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop'];

class InstallerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallerError';
  }
}

function shimPathFor(homeDir) {
  return path.join(homeDir, 'bin', 'bridge-hook.cjs');
}

function managedCommand(shimPath) {
  return `node "${shimPath}"`;
}

function isManagedCommand(command, shimPath) {
  return typeof command === 'string' && command.includes(shimPath);
}

function readSettings(settingsFile) {
  const settings = readJsonIfExists(settingsFile);
  if (settings === null) {
    if (fs.existsSync(settingsFile)) {
      throw new InstallerError(`settings file is not valid JSON: ${settingsFile}`);
    }
    return { hooks: {} };
  }
  if (typeof settings !== 'object' || settings === null) {
    throw new InstallerError(`settings file must contain a JSON object: ${settingsFile}`);
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  return settings;
}

function upsertManagedEntries(settings, shimPath) {
  const command = managedCommand(shimPath);
  const changed = [];
  for (const eventName of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[eventName])) {
      settings.hooks[eventName] = [];
    }
    const alreadyManaged = settings.hooks[eventName].some(
      (group) =>
        group &&
        Array.isArray(group.hooks) &&
        group.hooks.some((hook) => hook && hook.type === 'command' && isManagedCommand(hook.command, shimPath))
    );
    if (alreadyManaged) continue;
    settings.hooks[eventName].push({
      matcher: '*',
      hooks: [{ type: 'command', command }]
    });
    changed.push(eventName);
  }
  return changed;
}

function removeManagedEntries(settings, shimPath) {
  const removed = [];
  for (const eventName of Object.keys(settings.hooks)) {
    const groups = settings.hooks[eventName];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter(
      (group) =>
        !(
          group &&
          Array.isArray(group.hooks) &&
          group.hooks.some((hook) => hook && hook.type === 'command' && isManagedCommand(hook.command, shimPath))
        )
    );
    if (kept.length !== groups.length) removed.push(eventName);
    if (kept.length === 0) {
      delete settings.hooks[eventName];
    } else {
      settings.hooks[eventName] = kept;
    }
  }
  return removed;
}

// Host-level consumer registration is owned by the host (Project-Knowledge
// registers "project-knowledge" once via createBridge()). Connector
// installers mutate the registry only on explicit opt-in:
//   registerConsumer: true   -> register consumerName (legacy convenience)
//   unregisterConsumer: true -> unregister consumerName during uninstall
// Uninstalling a connector never deletes the shared runtime home.
async function installClaudeCodeHook({ homeDir, consumerName, consumerMeta = {}, registerConsumer = false, settingsFile, version } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = settingsFile || path.join(os.homedir(), '.claude', 'settings.json');
  const runtime = await ensureRuntimeHome({ homeDir: home, version });
  const registry = new ConsumerRegistry(home);
  if (consumerName && registerConsumer) {
    await registry.registerConsumer(consumerName, consumerMeta);
  }
  const settings = readSettings(target);
  const added = upsertManagedEntries(settings, shimPathFor(home));
  writeJsonAtomicSync(target, settings);
  return { added, settingsFile: target, runtime, consumers: (await registry.getConsumers()).map((c) => c.name) };
}

async function statusClaudeCodeHook({ homeDir, settingsFile } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = settingsFile || path.join(os.homedir(), '.claude', 'settings.json');
  const settings = readSettings(target);
  const shimPath = shimPathFor(home);
  const managedEvents = [];
  let thirdPartyCount = 0;
  for (const eventName of Object.keys(settings.hooks || {})) {
    const groups = settings.hooks[eventName];
    if (!Array.isArray(groups)) continue;
    let hasManaged = false;
    for (const group of groups) {
      for (const hook of (group && group.hooks) || []) {
        if (hook && hook.type === 'command') {
          if (isManagedCommand(hook.command, shimPath)) {
            hasManaged = true;
          } else {
            thirdPartyCount++;
          }
        }
      }
    }
    if (hasManaged) managedEvents.push(eventName);
  }
  const registry = new ConsumerRegistry(home);
  return {
    installed: HOOK_EVENTS.every((eventName) => managedEvents.includes(eventName)),
    managedEvents,
    thirdPartyCount,
    consumers: (await registry.getConsumers()).map((c) => c.name)
  };
}

async function repairClaudeCodeHook({ homeDir, consumerName, consumerMeta = {}, registerConsumer = false, settingsFile, version } = {}) {
  return installClaudeCodeHook({ homeDir, consumerName, consumerMeta, registerConsumer, settingsFile, version });
}

async function uninstallClaudeCodeHook({ homeDir, consumerName, unregisterConsumer = false, settingsFile } = {}) {
  const home = homeDir || path.join(os.homedir(), '.ai-coding-event-bridge');
  const target = settingsFile || path.join(os.homedir(), '.claude', 'settings.json');
  const registry = new ConsumerRegistry(home);
  const settings = readSettings(target);
  const removed = removeManagedEntries(settings, shimPathFor(home));
  writeJsonAtomicSync(target, settings);
  let consumerUnregistered = false;
  if (consumerName && unregisterConsumer) {
    await registry.unregisterConsumer(consumerName);
    consumerUnregistered = true;
  }
  return {
    removed: true,
    removedEvents: removed,
    settingsFile: target,
    consumerUnregistered,
    consumers: (await registry.getConsumers()).map((c) => c.name)
  };
}

module.exports = {
  HOOK_EVENTS,
  InstallerError,
  installClaudeCodeHook,
  statusClaudeCodeHook,
  repairClaudeCodeHook,
  uninstallClaudeCodeHook,
  managedCommand,
  isManagedCommand
};
