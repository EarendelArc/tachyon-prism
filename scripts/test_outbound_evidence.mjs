import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { canonicalizeOutbound, compareOutbounds } = require('./outbound_evidence.cjs');

const outbound = (credential) => ({
  tag: 'selected-node',
  protocol: 'vless',
  settings: {
    vnext: [{
      address: 'game.example.com',
      port: 443,
      users: [{ id: credential, encryption: 'none', flow: 'xtls-rprx-vision' }],
    }],
  },
  streamSettings: {
    network: 'tcp',
    security: 'reality',
    realitySettings: {
      serverName: 'game.example.com',
      publicKey: 'public-key-is-not-authentication-output',
      shortId: 'short-id-secret',
    },
  },
});

test('canonicalization includes authentication fields and is key-order stable', async () => {
  const first = outbound('credential-one');
  const reordered = { streamSettings: first.streamSettings, settings: first.settings, protocol: 'vless', tag: 'selected-node' };
  assert.equal(canonicalizeOutbound(first), canonicalizeOutbound(reordered));
  const comparison = await compareOutbounds(first, outbound('credential-two'), new Uint8Array(32).fill(7));
  assert.equal(comparison.objectsMatch, false);
  assert.notEqual(comparison.selectedHmac, comparison.catchAllHmac);
});

test('each comparison uses a fresh random HMAC key by default', async () => {
  const first = await compareOutbounds(outbound('same-secret'), outbound('same-secret'));
  const second = await compareOutbounds(outbound('same-secret'), outbound('same-secret'));
  assert.equal(first.objectsMatch, true);
  assert.equal(second.objectsMatch, true);
  assert.notEqual(first.selectedHmac, second.selectedHmac);
});

test('reported evidence is redacted while still comparing the complete object', async () => {
  const secret = 'uuid-password-private-key-token';
  const comparison = await compareOutbounds(outbound(secret), outbound(secret), new Uint8Array(32).fill(11));
  const output = JSON.stringify(comparison);
  assert.equal(comparison.objectsMatch, true);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /short-id-secret/);
  assert.match(comparison.selectedHmac, /^[0-9a-f]{64}$/);
});
