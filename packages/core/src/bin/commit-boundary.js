#!/usr/bin/env node
'use strict';

/**
 * Bridge commit-boundary injection point. Any git hook (or a human, or a
 * test) can signal "this repo just committed" by running:
 *
 *   node commit-boundary.js --cwd <repo> [--home <bridge home>]
 *                           [--sha <sha>] [--branch <name>] [--committed-at <iso>]
 *
 * The repo identity is resolved from the working tree (that is how the bridge
 * knows which registered project — and therefore which store — the commit
 * belongs to). Facts not provided are read from the repo's git. Output is a
 * single JSON line on stdout; errors exit non-zero so callers can distinguish
 * a failed injection from a skip.
 */

const { execFileSync } = require('child_process');
const { resolveRepoContext } = require('../core/repo-context');
const { createBridge } = require('../core/bridge');

function arg(name, fallback = '') {
  const prefix = `--${name}`;
  const argv = process.argv.slice(2);
  const index = argv.indexOf(prefix);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).trim();
}

async function main() {
  const cwd = arg('cwd', process.cwd());
  const repo = await resolveRepoContext(cwd);
  if (!repo || !repo.repoIdentity) {
    throw new Error(`not a Git work tree (no repo identity): ${cwd}`);
  }
  const commitSha = arg('sha') || git(cwd, ['rev-parse', 'HEAD']);
  const branch = arg('branch') || git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const committedAt = arg('committed-at') || git(cwd, ['log', '-1', '--format=%cI']);
  const subject = arg('subject') || git(cwd, ['log', '-1', '--format=%s']);
  const homeDir = arg('home') || undefined;
  const bridge = createBridge(homeDir ? { homeDir } : {});
  const result = await bridge.appendCommitBoundary({
    repoIdentity: repo.repoIdentity,
    commitSha,
    branch,
    subject,
    committedAt: committedAt || undefined
  });
  process.stdout.write(`${JSON.stringify({ ok: true, projectPath: repo.projectPath, ...result })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) })}\n`);
  process.exitCode = 1;
});
