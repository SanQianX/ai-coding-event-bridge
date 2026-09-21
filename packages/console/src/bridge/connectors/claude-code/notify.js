'use strict';

const http = require('http');
const https = require('https');
const { ConsumerRegistry } = require('../../core/consumer-registry');

function postJson(url, body, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const target = new URL(url);
      const mod = target.protocol === 'https:' ? https : http;
      const data = JSON.stringify(body);
      const req = mod.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
          timeout: timeoutMs
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ ok: res.statusCode && res.statusCode < 500 }));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false });
      });
      req.on('error', () => resolve({ ok: false }));
      req.end(data);
    } catch (_) {
      resolve({ ok: false });
    }
  });
}

/**
 * Best-effort wake-up for consumers that registered a notifyUrl. Always runs
 * after the durable append; failures never propagate to the AI client.
 */
async function notifyConsumers(home, info) {
  try {
    const registry = new ConsumerRegistry(home);
    const consumers = await registry.getConsumers();
    const urls = consumers
      .map((consumer) => consumer.meta && consumer.meta.notifyUrl)
      .filter((url) => typeof url === 'string' && url);
    await Promise.all(urls.map((url) => postJson(url, info)));
    return { notified: urls.length };
  } catch (_) {
    return { notified: 0 };
  }
}

module.exports = { notifyConsumers, postJson };
