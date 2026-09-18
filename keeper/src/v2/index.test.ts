/**
 * The mode switch: src/index.ts picks v1 or a v2 mode, and v2/index.ts starts that mode.
 *
 * WHY THIS FILE EXISTS: the same image runs the live v1 keepers and every v2 bot, told apart by
 * V2_MODE alone. Two failures would each take a service down: a v1 keeper whose boot changed when
 * the switch arrived, and a v2 process that evaluates the v1 config (which exits without
 * VAULT/FACTORY) before it reads V2_MODE. So the entry is run as a real process:
 *   - V2_MODE unset or blank: the process's exit code, stdout and stderr are the ones main-v1.ts
 *     (the old index.ts, moved unchanged) produces for the same environment, both for a refused
 *     environment and for a full boot that gets as far as the chain; log timestamps and the
 *     scratch path aside, byte for byte;
 *   - V2_MODE set: v1's message never appears; an unknown mode, a bad env and a mode not built yet
 *     each exit 1 with their own sentence; V2_MODE read from KEEPER_ENV_FILE counts; the cranker
 *     boots as far as its first chain read; pricing boots, answers, and exits 0 on SIGTERM.
 * In process, startV2 dispatches each mode's config to its starter; the real cranker, mm and pricer
 * starters boot as far as their first chain read.
 *
 * DELIBERATELY ABSENT: any RPC beyond a discard port on 127.0.0.1 (the v1 boot fails reaching it,
 * identically on both sides).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { V2ConfigError } from './config.js';
import { MODE_STARTERS, bootFailureMessage, startV2, type ModeStarters } from './index.js';
import { ModeNotImplementedError, requestedV2Mode, type RunningMode } from './mode.js';

const PKG = fileURLToPath(new URL('../../', import.meta.url));
const REGISTRY = fileURLToPath(new URL('./fixtures/registry-v2.json', import.meta.url));
const KEY = `0x${'11'.repeat(32)}`;
const RPC = 'http://127.0.0.1:9';

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `entry` under tsx with exactly `env` (plus PATH, and KEEPER_ENV_FILE=/dev/null unless given):
 * nothing leaks in from the test runner's environment or a keeper/.env.
 */
function run(entry: string, env: Record<string, string>, options: { onStdout?: (text: string, kill: (s: NodeJS.Signals) => void) => void; timeoutMs?: number } = {}): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: PKG,
      env: { PATH: process.env.PATH ?? '', KEEPER_ENV_FILE: '/dev/null', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${entry} did not exit within ${options.timeoutMs ?? 20_000} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, options.timeoutMs ?? 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      options.onStdout?.(stdout, (s) => child.kill(s));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/*//////////////////////////////////////////////////////////////
                       V2_MODE UNSET: v1
//////////////////////////////////////////////////////////////*/

test('requestedV2Mode: unset, empty and blank mean v1; anything else is v2, trimmed', () => {
  assert.equal(requestedV2Mode({}), undefined);
  assert.equal(requestedV2Mode({ V2_MODE: '' }), undefined);
  assert.equal(requestedV2Mode({ V2_MODE: ' \t' }), undefined);
  assert.equal(requestedV2Mode({ V2_MODE: ' cranker ' }), 'cranker');
  assert.equal(requestedV2Mode({ V2_MODE: 'nonsense' }), 'nonsense');
});

test('V2_MODE unset: a refused v1 environment exits exactly as main-v1.ts does (the old index.ts)', async () => {
  const env = { RH_RPC: RPC, KEEPER_PK: KEY };
  const [viaSwitch, direct] = await Promise.all([run('src/index.ts', env), run('src/main-v1.ts', env)]);
  assert.equal(viaSwitch.code, 1);
  assert.match(viaSwitch.stderr, /Keeper configuration is not usable\. Fix these and restart:\n {2}VAULT \/ FACTORY: at least one must be set/);
  assert.deepEqual(viaSwitch, direct);

  const blank = await run('src/index.ts', { ...env, V2_MODE: '  ' });
  assert.deepEqual(blank, direct, 'a blank V2_MODE is unset');
});

test('V2_MODE unset: a full v1 factory boot (database, boot line, chain read, fatal exit) matches main-v1.ts line for line', async () => {
  const boot = async (entry: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'callhouse-v1-boot-'));
    const exit = await run(entry, { RH_RPC: RPC, KEEPER_PK: KEY, FACTORY: '0x2222222222222222222222222222222222222222', KEEPER_DB_PATH: join(dir, 'keeper.db') });
    // Only the clock and the scratch directory differ between two runs.
    const stdout = exit.stdout
      .split(dir)
      .join('<dir>')
      .replace(/"time":\d+/g, '"time":0');
    return { ...exit, stdout };
  };
  const [viaSwitch, direct] = await Promise.all([boot('src/index.ts'), boot('src/main-v1.ts')]);
  assert.equal(viaSwitch.code, 1);
  assert.match(viaSwitch.stdout, /"msg":"callhouse keeper starting"/);
  assert.match(viaSwitch.stdout, /"level":"fatal".*"msg":"keeper failed to start"/);
  assert.deepEqual(viaSwitch, direct);
});

/*//////////////////////////////////////////////////////////////
                        V2_MODE SET: v2
//////////////////////////////////////////////////////////////*/

test('V2_MODE=cranker with a valid environment boots the cranker (K2-03) as far as the chain, and the v1 config is never evaluated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'callhouse-cranker-boot-'));
  const exit = await run('src/index.ts', { V2_MODE: 'cranker', RH_RPC: RPC, CRANKER_PK: KEY, V2_REGISTRY_PATH: REGISTRY, KEEPER_DB_PATH: join(dir, 'cranker.db'), KEEPER_BOOT_RETRY_MS: '0', CRANKER_PORT: '0' });
  assert.equal(exit.code, 1);
  // The boot's wiring check is the first chain read; nothing listens on the discard port.
  assert.match(exit.stderr.trim(), /^v2 cranker failed to start: HTTP request failed/);
  assert.match(exit.stdout, /"msg":"cranker starting"/);
  assert.doesNotMatch(exit.stdout + exit.stderr, /Keeper configuration is not usable|not implemented yet/);
});

test('V2_MODE set but wrong: an unknown mode, and a bad mm environment read from KEEPER_ENV_FILE, each exit 1 with v2\'s list', async () => {
  const unknown = await run('src/index.ts', { V2_MODE: 'crank' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /v2 configuration is not usable\. Fix these and restart:\n {2}V2_MODE: must be one of cranker \| pricing \| mm \| pricer \(got "crank"\)/);
  assert.doesNotMatch(unknown.stderr, /Keeper configuration is not usable/);

  const dir = mkdtempSync(join(tmpdir(), 'callhouse-v2-env-'));
  const envFile = join(dir, 'mm.env');
  writeFileSync(envFile, `V2_MODE=mm\nRH_RPC=${RPC}\nV2_REGISTRY_PATH=${REGISTRY}\n`);
  const fromFile = await run('src/index.ts', { KEEPER_ENV_FILE: envFile });
  assert.equal(fromFile.code, 1);
  assert.match(fromFile.stderr, /MM_QUOTER_PK: Required/);
  assert.match(fromFile.stderr, /PRICING_URL: Required/);
  assert.doesNotMatch(fromFile.stderr, /RH_RPC|MAKER_VAULT/, 'the file\'s RH_RPC counted, the registry has the maker vault');
});

test('V2_MODE=pricing: boots on PRICING_PORT, answers /health, exits 0 on SIGTERM', async () => {
  let port: number | null = null;
  const exit = await run(
    'src/index.ts',
    { V2_MODE: 'pricing', RH_RPC: RPC, PRICING_PORT: '0', V2_REGISTRY_PATH: REGISTRY, KEEPER_LOG_LEVEL: 'info' },
    {
      onStdout: (text, kill) => {
        const match = /"port":(\d+).*"msg":"pricing service listening"/.exec(text);
        if (match && port === null) {
          port = Number(match[1]);
          fetch(`http://127.0.0.1:${port}/health`)
            .then(async (res) => {
              assert.equal(res.status, 200);
              kill('SIGTERM');
            })
            .catch(() => kill('SIGKILL'));
        }
      },
    },
  );
  assert.ok(port !== null && port > 0, `no listening line in: ${exit.stdout}`);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, exit.stderr);
});

/*//////////////////////////////////////////////////////////////
                           IN PROCESS
//////////////////////////////////////////////////////////////*/

const fakeRunning = (mode: RunningMode['mode']): RunningMode => ({ mode, port: null, close: async () => {} });

test('startV2 hands each mode its own validated config; the pricing starter also gets the raw environment', async () => {
  const seen: string[] = [];
  const starters: ModeStarters = {
    cranker: async (c) => (seen.push(`cranker ${c.keyEnv} ${c.port}`), fakeRunning('cranker')),
    mm: async (c) => (seen.push(`mm ${c.keyEnv} ${c.pricingUrl}`), fakeRunning('mm')),
    pricer: async (c) => (seen.push(`pricer ${c.keyEnv} ${c.indexerUrl}`), fakeRunning('pricer')),
    pricing: async (c, env) => (seen.push(`pricing ${c.pricing.port} ${env.PRICING_PORT}`), fakeRunning('pricing')),
  };
  const common = { RH_RPC: RPC, V2_REGISTRY_PATH: REGISTRY };
  await startV2({ ...common, V2_MODE: 'cranker', CRANKER_PK: KEY }, starters);
  await startV2({ ...common, V2_MODE: 'mm', MM_QUOTER_PK: KEY, PRICING_URL: 'http://p:8790', INDEXER_URL: 'http://i:42069', MM_KILL_TOKEN: 'k'.repeat(32) }, starters);
  await startV2({ ...common, V2_MODE: 'pricer', PRICER_PK: KEY, PRICING_URL: 'http://p:8790', INDEXER_URL: 'http://i:42069' }, starters);
  await startV2({ ...common, V2_MODE: 'pricing', PRICING_PORT: '8799' }, starters);
  assert.deepEqual(seen, ['cranker CRANKER_PK 8792', 'mm MM_QUOTER_PK http://p:8790', 'pricer PRICER_PK http://i:42069', 'pricing 8799 8799']);
  await assert.rejects(startV2({ V2_MODE: 'cranker' }, starters), V2ConfigError);
});

test('the real starters: the cranker, the MM bot and the pricer boot (and stop at an unreachable chain); pricing starts and closes', async () => {
  const common = { RH_RPC: RPC, V2_REGISTRY_PATH: REGISTRY, PRICING_URL: 'http://p:8790', INDEXER_URL: 'http://i:42069', KEEPER_BOOT_RETRY_MS: '0' };
  for (const env of [
    { ...common, V2_MODE: 'cranker', CRANKER_PK: KEY, CRANKER_PORT: '0', KEEPER_DB_PATH: ':memory:', KEEPER_LOG_LEVEL: 'silent' },
    { ...common, V2_MODE: 'mm', MM_QUOTER_PK: KEY, MM_PORT: '0', MM_KILL_TOKEN: 'k'.repeat(32), KEEPER_DB_PATH: ':memory:', KEEPER_LOG_LEVEL: 'silent' },
    { ...common, V2_MODE: 'pricer', PRICER_PK: KEY, PRICER_PORT: '0', KEEPER_DB_PATH: ':memory:', KEEPER_LOG_LEVEL: 'silent' },
  ]) {
    await assert.rejects(startV2(env, MODE_STARTERS), (error: unknown) => !(error instanceof ModeNotImplementedError) && /HTTP request failed/.test(String(error)));
  }

  const pricing = await startV2({ V2_MODE: 'pricing', RH_RPC: RPC, V2_REGISTRY_PATH: REGISTRY, PRICING_PORT: '0', KEEPER_LOG_LEVEL: 'silent' }, MODE_STARTERS);
  assert.equal(pricing.mode, 'pricing');
  assert.ok(pricing.port !== null && pricing.port > 0);
  assert.equal((await fetch(`http://127.0.0.1:${pricing.port}/health`)).status, 200);
  await pricing.close();
});

test('bootFailureMessage: not built yet, a config list as is, anything else prefixed with the mode', () => {
  assert.equal(
    bootFailureMessage(new ModeNotImplementedError('mm', 'K2-04'), 'mm'),
    'V2_MODE=mm is not implemented yet (K2-04 builds it). The configuration is valid; nothing was started. Unset V2_MODE for the v1 keeper.',
  );
  assert.equal(bootFailureMessage(new V2ConfigError('v2 configuration is not usable'), 'cranker'), 'v2 configuration is not usable');
  assert.equal(bootFailureMessage(new Error('listen EADDRINUSE: :::8792'), 'cranker'), 'v2 cranker failed to start: listen EADDRINUSE: :::8792');
});

test('bootFailureMessage: an RPC failure names the RPC by origin only; a key in the URL path or query is never printed', async () => {
  const { createPublicClient, http } = await import('viem');
  const client = createPublicClient({ transport: http('http://127.0.0.1:9/v2/SECRETKEY456?apikey=QUERYSECRET', { retryCount: 0, timeout: 2_000 }) });
  const error = await client.getBlockNumber().catch((e: unknown) => e);
  assert.match(String((error as Error).message), /SECRETKEY456/, 'viem\'s own message carries the URL');
  const message = bootFailureMessage(error, 'cranker');
  assert.doesNotMatch(message, /SECRETKEY456|QUERYSECRET/);
  assert.match(message, /http:\/\/127\.0\.0\.1:9/);
  assert.match(message, /v2 cranker failed to start: /);
});
