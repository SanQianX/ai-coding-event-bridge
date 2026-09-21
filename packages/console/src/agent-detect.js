'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./bridge');

/**
 * Detection of AI coding agent tools on this machine. "Installed" means the
 * CLI is on PATH or its config exists; "hookInstalled" means the bridge shim
 * is wired in — either as the installer's managed entry, or through a
 * consumer fan-out chain (for example Codex notify lines that forward to the
 * shim base64-encoded), which the managed-entry check alone would miss.
 */

function commandExists(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(finder, [command], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

function readTextIfAny(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function mentionsShim(text) {
  return typeof text === 'string' && (text.includes('bridge-hook.cjs') || text.includes('--bridge-base64'));
}

async function detectAgents({ claudeSettingsFile, codexConfigFile, opencodePluginsDir, zcodeConfigFile } = {}) {
  const home = os.homedir();

  const claudeFiles = [
    claudeSettingsFile || path.join(home, '.claude', 'settings.json'),
    path.join(path.dirname(claudeSettingsFile || path.join(home, '.claude', 'settings.json')), 'settings.local.json')
  ];
  const claudeStatus = await core.installers.claudeCode.statusClaudeCodeHook({
    settingsFile: claudeFiles[0]
  });
  const claudeConfigFound = claudeFiles.some(fileExists);
  const claudeTextHooked = claudeFiles.some((file) => mentionsShim(readTextIfAny(file)));

  const codexFile = codexConfigFile || path.join(home, '.codex', 'config.toml');
  const codexStatus = await core.installers.codex.statusCodexNotify({ configFile: codexFile });
  const codexConfigFound = fileExists(codexFile);
  const codexTextHooked = mentionsShim(readTextIfAny(codexFile));

  const opencodeDir = opencodePluginsDir || path.join(home, '.config', 'opencode', 'plugin');
  const opencodeStatus = await core.installers.openCode.statusOpenCodePlugin({ pluginsDir: opencodeDir });
  let opencodePluginHooked = Boolean(opencodeStatus.installed);
  if (!opencodePluginHooked) {
    try {
      for (const name of fs.readdirSync(opencodeDir)) {
        if (mentionsShim(readTextIfAny(path.join(opencodeDir, name)))) {
          opencodePluginHooked = true;
          break;
        }
      }
    } catch (_) {
      /* no plugin dir */
    }
  }

  const zcodeFile = zcodeConfigFile || path.join(home, '.zcode', 'cli', 'config.json');
  const zcodeStatus = await core.installers.zcode.statusZcodeHook({ configFile: zcodeFile });
  const zcodeConfigText = readTextIfAny(zcodeFile);

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      cliFound: commandExists('claude'),
      configFound: claudeConfigFound,
      hookInstalled: Boolean(claudeStatus.installed) || claudeTextHooked,
      managed: Boolean(claudeStatus.installed),
      managedEvents: claudeStatus.managedEvents || [],
      detail: claudeStatus.thirdPartyCount ? `另有 ${claudeStatus.thirdPartyCount} 条第三方 hook（保留不动）` : null
    },
    {
      id: 'codex',
      label: 'Codex',
      cliFound: commandExists('codex'),
      configFound: codexConfigFound,
      hookInstalled: Boolean(codexStatus.installed) || codexTextHooked,
      managed: Boolean(codexStatus.installed),
      detail: codexStatus.thirdParty ? 'notify 已被第三方/消费方链占用（转发链仍会调用 bridge）' : null
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      cliFound: commandExists('opencode'),
      configFound: fileExists(path.join(path.dirname(opencodeDir), 'opencode.jsonc')) || fileExists(path.join(path.dirname(opencodeDir), 'opencode.json')),
      hookInstalled: opencodePluginHooked,
      managed: Boolean(opencodeStatus.installed),
      detail: opencodeStatus.thirdPartyFiles && opencodeStatus.thirdPartyFiles.length
        ? `插件目录另有 ${opencodeStatus.thirdPartyFiles.length} 个第三方插件（保留不动）`
        : null
    },
    {
      id: 'zcode',
      label: 'ZCode',
      cliFound: commandExists('zcode'),
      configFound: fileExists(zcodeFile),
      hookInstalled: Boolean(zcodeStatus.installed) || mentionsShim(zcodeConfigText),
      managed: Boolean(zcodeStatus.installed),
      detail: zcodeStatus.thirdPartyCount ? `配置中另有 ${zcodeStatus.thirdPartyCount} 条第三方 hook（保留不动）` : null
    }
  ];
}

module.exports = { detectAgents, commandExists };
