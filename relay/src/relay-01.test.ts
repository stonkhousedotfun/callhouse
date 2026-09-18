/**
 * SWEEP relay-01 (relay-05 is the same defect). server.ts parses `req.url` with WHATWG `new URL`
 * synchronously in the createServer callback before this regression was fixed,
 * outside the `route().catch` guard. Node's HTTP parser accepts request targets that WHATWG URL
 * rejects, so one unauthenticated raw request throws ERR_INVALID_URL out of the 'request' listener
 * and the process exits 1.
 *
 * The relay runs in a child process (tsx on this same file with SWEEP_RELAY_CHILD=1), because the
 * crash takes the whole process down. The test sends one raw request with no token, then requires
 * the child to still be alive and /health to still answer 200.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './config.js';
import { createLogger } from './log.js';
import { createRelayServer } from './server.js';

const TOKEN = 'relay-token-SECRET-0123456789abcdef0123456789';

if (process.env.SWEEP_RELAY_CHILD === '1') {
  const config = parseConfig({ RELAY_TOKEN: TOKEN, DISCORD_WEBHOOK_URL: 'http://127.0.0.1:9/api/webhooks/1/x' });
  const server = createRelayServer(config, { logger: createLogger(() => {}) });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`PORT ${(server.address() as AddressInfo).port}\n`);
  });
} else {
  const self = fileURLToPath(import.meta.url);

  async function startChild(): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
    // Spawn Node directly: the tsx CLI launches a grandchild that survives killing its wrapper.
    const child = spawn(process.execPath, ['--import', 'tsx', self], {
      env: { ...process.env, SWEEP_RELAY_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
        const m = /PORT (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', (code) => reject(new Error(`child exited ${code} before listening: ${err}`)));
    });
    return { child, port, stderr: () => err };
  }

  function rawGet(port: number, target: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n`));
      socket.on('data', (c: Buffer) => (data += c.toString('utf8')));
      socket.on('error', () => resolve(data));
      socket.on('close', () => resolve(data));
    });
  }

  const exited = (child: ChildProcess, ms: number) =>
    new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      const timer = setTimeout(() => resolve(null), ms);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  for (const target of ['///', '//999.999.999.999/alert', '//[/']) {
    test(`unauthenticated raw GET ${target} must not kill the relay`, async () => {
      const { child, port, stderr } = await startChild();
      try {
        const reply = await rawGet(port, target);
        const code = await exited(child, 500);
        assert.equal(code, null, `relay process exited with code ${code} after one raw request (reply: ${JSON.stringify(reply)}). stderr:\n${stderr().split('\n').filter((l) => /Error|at Server|server\.ts|code:|input:/.test(l)).slice(0, 8).join('\n')}`);
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 200);
        assert.match(reply, /^HTTP\/1\.1 4\d\d /, 'expected a 4xx answer to an unparseable target');
      } finally {
        child.kill('SIGKILL');
      }
    });
  }
}
