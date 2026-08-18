'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const testDirs = ['packages/core/test', 'packages/ui/test'];

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
      require(path.join(absDir, name));
      console.log('PASS');
    } catch (err) {
      failed++;
      console.log('FAIL');
      console.error(err && err.stack ? err.stack : err);
    }
  }
}

if (ran === 0) {
  console.error('No scaffold test files found');
  process.exit(1);
}
if (failed > 0) {
  console.error(`${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`Scaffold suite: ${ran} passed, 0 failed`);
