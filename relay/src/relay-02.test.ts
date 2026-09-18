/**
 * SWEEP relay-02. config.ts:59-64 keeps RELAY_TOKEN untrimmed (blankIsUnset only drops all-blank
 * values). Every sender trims its copy: keeper/src/v2/config.ts:456 and keeper/src/config.ts:311 trim
 * every env value, and fetch strips leading/trailing whitespace from header values. server.ts:61
 * trims the presented Bearer value too. So a RELAY_TOKEN stored with surrounding whitespace (a
 * pasted value in the Railway UI) boots, and every Bearer alert is 401 forever.
 *
 * Pass condition: parseConfig either refuses such a token at boot, or trims it so the trimmed
 * Bearer value that ${{relay.RELAY_TOKEN}} -> ALERT_WEBHOOK_TOKEN -> keeper sends is accepted.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ConfigError, parseConfig } from './config.js';
import { createLogger } from './log.js';
import { createRelayServer } from './server.js';
import type { Target } from './targets.js';

const HEX = 'a1b2c3d4'.repeat(8); // 64 hex chars, the shape of `openssl rand -hex 32`

const SAMPLE = { source: 'callhouse-cranker', kind: 'v2_boot', severity: 'info', message: 'boot', data: {} };

for (const [label, stored] of [
  ['trailing newline', `${HEX}\n`],
  ['trailing space', `${HEX} `],
  ['leading space', ` ${HEX}`],
] as const) {
  test(`RELAY_TOKEN with ${label}: refused at boot, or the trimmed Bearer value is accepted`, async () => {
    let config;
    try {
      config = parseConfig({ RELAY_TOKEN: stored, DISCORD_WEBHOOK_URL: 'http://127.0.0.1:9/api/webhooks/1/x' });
    } catch (error) {
      if (error instanceof ConfigError) return; // refusing to boot is a pass
      throw error;
    }
    const accepted: Target = { name: 'discord', deliver: async () => ({ target: 'discord', ok: true, status: 204 }) };
    const server = createRelayServer(config, { logger: createLogger(() => {}), targets: [accepted] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alert`;
      // What the keeper/bots send: ALERT_WEBHOOK_TOKEN (= ${{relay.RELAY_TOKEN}}) trimmed by their config loader.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${stored.trim()}` },
        body: JSON.stringify(SAMPLE),
      });
      assert.equal(res.status, 200, `relay booted with a whitespace-padded RELAY_TOKEN and refused the sender's Bearer token with ${res.status}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
