'use strict';

const assert = require('assert');
const { parseSelectedPath } = require('../src/pick-folder');

async function main() {
  assert.strictEqual(parseSelectedPath('D:\\work\\repo\n'), 'D:\\work\\repo', 'trailing newline trimmed');
  assert.strictEqual(parseSelectedPath('\uFEFF"D:\\work\\repo"'), 'D:\\work\\repo', 'BOM and quotes stripped');
  assert.strictEqual(parseSelectedPath('\u0000\u0000'), null, 'null bytes mean no selection');
  assert.strictEqual(parseSelectedPath('   '), null, 'blank output means cancelled');
  assert.strictEqual(parseSelectedPath(undefined), null, 'missing output means cancelled');

  console.log('pick-folder-test: ok');
}

module.exports = main();
