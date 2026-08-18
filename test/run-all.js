'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const testDirs = ['packages/core/test', 'packages/ui/test'];

async function main() {
  let failed = 0;
  let ran = 0;
  for (const dir of testDirs) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const name of fs.readdirSync(absDir).sort()) {
      if (!name.endsWith('-test.js')) continue;
      ran++;
      process.stdout.write(`> ${dir}/${name} ... `);
      try {
        const result = require(path.join(absDir, name));
        if (result && typeof result.then === 'function') {
          await result;
        }
        console.log('PASS');
      } catch (err) {
        failed++;
        console.log('FAIL');
        console.error(err && err.stack ? err.stack : err);
      }
    }
  }
  if (ran === 0) {
    throw new Error('No test files found');
  }
  if (failed > 0) {
    throw new Error(`${failed} test file(s) failed`);
  }
  console.log(`Scaffold suite: ${ran} passed, 0 failed`);
}

module.exports = main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
