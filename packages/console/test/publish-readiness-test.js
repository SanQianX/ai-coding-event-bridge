'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

async function main() {
  // Publish workflow: workflow_dispatch only, SHA-guarded, provenance, no tag trigger.
  const publish = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(publish, /workflow_dispatch:/, 'publish is dispatch-guarded');
  assert.doesNotMatch(publish, /^\s*push:/m, 'publish must never trigger on push');
  assert.doesNotMatch(publish, /^\s*tags:/m, 'publish must never trigger on tags');
  assert.match(publish, /expected_sha/, 'dispatch requires the exact verified SHA');
  assert.match(publish, /GITHUB_SHA/, 'workflow verifies the dispatched commit');
  assert.match(publish, /--provenance/, 'the package publishes with npm provenance');
  assert.match(publish, /NODE_AUTH_TOKEN/, 'publish uses a scoped token secret');
  assert(publish.includes('npm publish --workspace packages/console'), 'the single console workspace is what publishes');

  // Single-package repo: the console is self-contained — no runtime dependencies,
  // the vendored bridge ships inside it, and the command name equals the package name.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'console', 'package.json'), 'utf8'));
  assert.strictEqual(manifest.license, 'MIT');
  assert.strictEqual(manifest.engines.node, '>=18');
  assert.strictEqual(manifest.dependencies, undefined, 'no runtime dependencies: the package is self-contained');
  assert(manifest.bin && manifest.bin['ai-coding-event-bridge-console'], 'package-name command present');
  assert(fs.existsSync(path.join(ROOT, 'packages', 'console', 'src', 'bridge', 'index.js')), 'vendored bridge present');
  assert(!fs.existsSync(path.join(ROOT, 'packages', 'core')), 'legacy core package removed');
  assert(!fs.existsSync(path.join(ROOT, 'packages', 'ui')), 'legacy ui package removed');
  assert(fs.existsSync(path.join(ROOT, 'LICENSE')), 'repository license present');
  assert(fs.existsSync(path.join(ROOT, 'README.md')), 'repository readme present');

  // npm pack contents: the vendored bridge ships, tests never do.
  const pack = JSON.parse(
    execFileSync('npm', ['pack', '--workspace', 'packages/console', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true })
  );
  const files = pack[0].files.map((f) => f.path);
  assert(files.includes('README.md') || files.includes('LICENSE'), 'tarball carries package legal files');
  assert(files.includes('src/bridge/index.js'), 'vendored bridge ships inside the tarball');
  assert(!files.some((f) => f.startsWith('test/')), 'tests never ship');
}

module.exports = main();
