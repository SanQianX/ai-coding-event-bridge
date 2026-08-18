'use strict';

// Child-process append worker used by concurrency and boundary race tests.
// Usage: node append-worker.js <homeDir> <count> [repoIdentity] [source]

const path = require('path');
const { Journal } = require('../../src/core/journal');

async function main() {
  const [homeDir, countArg, repoArg, sourceArg] = process.argv.slice(2);
  const count = Number(countArg);
  const repoIdentity = repoArg || 'git@github.com:acme/repo.git';
  const source = sourceArg || 'claude-code';
  const journal = new Journal(path.join(homeDir, 'journal'));
  for (let i = 0; i < count; i++) {
    await journal.appendEvent({
      source,
      eventType: 'user_prompt',
      role: 'user',
      content: `worker ${process.pid} prompt ${i}`,
      repoIdentity,
      sessionId: `session-${process.pid}`,
      turnId: `turn-${process.pid}-${i}`
    });
  }
  const bounds = await journal.getBounds();
  process.stdout.write(JSON.stringify(bounds));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
