'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

/**
 * Resolve repo identity for a working directory. Identity prefers the Git
 * origin URL (normalized across git/https schemes); it falls back to the real
 * filesystem path of the Git toplevel, and reports unavailable outside a repo.
 */
async function resolveRepoContext(cwd, { runGit = runGitDefault } = {}) {
  const projectPath = realpathBestEffort(cwd) || cwd;
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
  const realToplevel = realpathBestEffort(toplevel);
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
  const urlIdentity = normalizeGitUrl(origin);
  return {
    repoIdentity: urlIdentity || realToplevel || projectPath,
    projectPath: realToplevel || projectPath,
    branch: branch === 'HEAD' ? null : branch,
    headAtCapture: head,
    identityConfidence: urlIdentity ? 'exact' : realToplevel ? 'partial' : 'unavailable'
  };
}

module.exports = { normalizeGitUrl, resolveRepoContext, realpathBestEffort };
