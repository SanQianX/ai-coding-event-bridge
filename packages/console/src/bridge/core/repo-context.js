'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO_IDENTITY_SCHEMA = 'repo-identity/v1';

function normalizeGitUrl(url) {
  if (typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  let match = /^git@([^:]+):(.+?)(?:\.git)?$/i.exec(u);
  if (match) return `${match[1].toLowerCase()}/${match[2].replace(/\.git$/, '')}`;
  match = /^(?:https?|ssh|git):\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/i.exec(u);
  if (match) return `${match[1].toLowerCase()}/${match[2].replace(/\.git$/, '')}`;
  return u.replace(/\.git$/, '');
}

function runGitDefault(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout).trim());
    });
  });
}

function realpathBestEffort(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch (_) {
    return null;
  }
}

// Comparison form: identity comparisons are case-insensitive on Windows and
// separator-insensitive everywhere. The display workspaceRoot keeps its
// on-disk casing; only the hash/comparison form is normalized.
function comparisonForm(target) {
  let value = String(target).replace(/\\/g, '/');
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  if (process.platform === 'win32') value = value.toLowerCase();
  return value;
}

function workspaceIdFor(workspaceRoot) {
  const digest = crypto.createHash('sha256').update(comparisonForm(workspaceRoot)).digest('hex');
  return `sha256:${digest}`;
}

function isValidRepoIdentityV1(identity) {
  return Boolean(
    identity &&
    typeof identity === 'object' &&
    identity.schema === REPO_IDENTITY_SCHEMA &&
    typeof identity.workspaceId === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(identity.workspaceId) &&
    typeof identity.workspaceRoot === 'string' &&
    identity.workspaceRoot.length > 0 &&
    (identity.commonDir === null || identity.commonDir === undefined || typeof identity.commonDir === 'string') &&
    (identity.remote === null || identity.remote === undefined || typeof identity.remote === 'string')
  );
}

// Journal/projection key. v1 identities key by workspaceId; plain strings are
// legacy journal records written before repo-identity/v1 and stay readable.
function repoIdentityKey(identity) {
  if (identity === null || identity === undefined) return null;
  if (typeof identity === 'string') return identity;
  if (isValidRepoIdentityV1(identity)) return identity.workspaceId;
  return null;
}

// Turn-namespace key: events with no repo identity at all share the 'no-repo'
// namespace so same-session binding still works outside Git repos, while
// malformed identity objects get a unique namespace and never cross-bind.
function turnScopeKey(identity) {
  if (identity === null || identity === undefined) return 'no-repo';
  const key = repoIdentityKey(identity);
  if (key !== null) return key;
  try {
    return `invalid:${JSON.stringify(identity).slice(0, 64)}`;
  } catch (_) {
    return 'invalid:unserializable';
  }
}

function sameRepoIdentity(a, b) {
  const keyA = repoIdentityKey(a);
  const keyB = repoIdentityKey(b);
  if (keyA === null || keyB === null) return false;
  return keyA === keyB;
}

function buildRepoIdentityV1({ workspaceRoot, commonDir = null, remote = null }) {
  return {
    schema: REPO_IDENTITY_SCHEMA,
    workspaceId: workspaceIdFor(workspaceRoot),
    workspaceRoot,
    commonDir: commonDir === undefined ? null : commonDir,
    remote: remote === undefined ? null : remote
  };
}

/**
 * Canonical workspace identity for an authoritative development cwd.
 *
 * 1. `git rev-parse --show-toplevel` (authoritative Git working tree root)
 * 2. realpath + canonical separators for the display root
 * 3. workspaceId = sha256 over the comparison form (case-insensitive on win32)
 * 4. commonDir from `git rev-parse --path-format=absolute --git-common-dir`
 *    (metadata: worktrees share it, but their workspaceIds differ)
 * 5. normalized origin URL as metadata only — never the primary identity
 *
 * Non-Git cwd => repoIdentity null + identityConfidence 'unavailable'.
 * No fallback to process.cwd, no fake workspaceId, remote never overrides.
 */
async function resolveRepoContext(cwd, { runGit = runGitDefault } = {}) {
  const projectPath = realpathBestEffort(cwd) || path.resolve(cwd);
  let toplevel = null;
  try {
    toplevel = await runGit(['rev-parse', '--show-toplevel'], cwd);
  } catch (_) {
    return {
      repoIdentity: null,
      projectPath,
      branch: null,
      headAtCapture: null,
      identityConfidence: 'unavailable'
    };
  }
  const realToplevel = path.resolve(realpathBestEffort(toplevel) || toplevel);

  let commonDir = null;
  try {
    const rawCommonDir = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
    if (rawCommonDir) commonDir = path.resolve(realpathBestEffort(rawCommonDir) || rawCommonDir);
  } catch (_) {
    commonDir = null;
  }

  let origin = null;
  try {
    origin = await runGit(['config', '--get', 'remote.origin.url'], cwd);
  } catch (_) {
    origin = null;
  }
  let branch = null;
  try {
    branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch (_) {
    branch = null;
  }
  let head = null;
  try {
    head = await runGit(['rev-parse', 'HEAD'], cwd);
  } catch (_) {
    head = null;
  }

  return {
    repoIdentity: buildRepoIdentityV1({
      workspaceRoot: realToplevel,
      commonDir,
      remote: normalizeGitUrl(origin)
    }),
    projectPath: realToplevel,
    branch: branch === 'HEAD' ? null : branch,
    headAtCapture: head,
    identityConfidence: 'exact'
  };
}

module.exports = {
  REPO_IDENTITY_SCHEMA,
  normalizeGitUrl,
  resolveRepoContext,
  realpathBestEffort,
  comparisonForm,
  workspaceIdFor,
  buildRepoIdentityV1,
  isValidRepoIdentityV1,
  repoIdentityKey,
  turnScopeKey,
  sameRepoIdentity
};
