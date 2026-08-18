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
  assert.match(publish, /--provenance/, 'packages publish with npm provenance');
  assert.match(publish, /NODE_AUTH_TOKEN/, 'publish uses a scoped token secret');
  assert(publish.includes('npm publish --workspace packages/core') && publish.includes('npm publish --workspace packages/ui'));

  // Package metadata: license + readme ship, versions stay in lockstep, engine >=18.
  for (const pkg of ['packages/core', 'packages/ui']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, pkg, 'package.json'), 'utf8'));
    assert.strictEqual(manifest.license, 'MIT');
    assert.strictEqual(manifest.engines.node, '>=18');
    assert.strictEqual(manifest.version, '0.1.0');
  }
  assert(fs.existsSync(path.join(ROOT, 'LICENSE')), 'repository license present');
  assert(fs.existsSync(path.join(ROOT, 'README.md')), 'repository readme present');

  // npm pack contents include the license/readme; tests never ship.
  const corePack = JSON.parse(
    execFileSync('npm', ['pack', '--workspace', 'packages/core', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' })
  );
  const coreFiles = corePack[0].files.map(f => f.path);
  assert(coreFiles.includes('LICENSE') || coreFiles.includes('README.md'), 'core tarball carries package legal files');
  assert(!coreFiles.some(f => f.startsWith('test/')), 'tests never ship');

  const uiPack = JSON.parse(
    execFileSync('npm', ['pack', '--workspace', 'packages/ui', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' })
  );
  const uiFiles = uiPack[0].files.map(f => f.path);
  assert(uiFiles.includes('src/conversation-explorer.css'), 'explorer css ships');
  assert(!uiFiles.some(f => f.startsWith('test/')), 'ui tests never ship');

  console.log('publish-readiness-test PASS');
}

module.exports = main();
