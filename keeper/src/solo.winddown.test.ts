/**
 * v1 run-off (SOLO_WIND_DOWN=1) through the real solo tick, with the factory, its accounts and the
 * feed stubbed; and the registry flag that turns it on, through ops/keeper-env.sh into this config.
 *
 * WHY THIS FILE EXISTS: ADR-10 freezes every v1 factory and lets its listed weeks expire. The keeper
 * of a frozen factory must do three things and no more: never `setWeek` (a fresh week on a frozen
 * factory is a market nobody can list into), never `listFor` (every one reverts WritesAreHalted),
 * and keep settling every expired account, because nothing else hands an owner their collateral
 * back. The pooled vault's WIND_DOWN has the same shape but no tick test of its own; this file pins
 * the factory's, and the one new behaviour: `v1_drained` goes out once per factory when nothing is
 * live or pending, the fact is kept in SQLite so a restart does not say it again, and a failed
 * delivery is retried rather than marked. The same chain states are ticked with the flag off, so
 * it is the flag, not the stubs, that stops the week and the lists.
 *
 * The settle guard (both modes, pinned here because run-off is where it matters most): an expired
 * account with `claimKey() != 0` is not settled while USDG is paused, the account or the Clear is
 * frozen on USDG or blocked on the Stock Token, or the Stock Token is paused (the six reads of
 * `settle_safe`, ops/runbooks/v1-runoff.md step 8), nor while any of those reads fails. Each gate
 * holds and alerts `v1_settle_held` once per account; a gate that opens again lets the account
 * settle on the next tick and forgets the alert; `claimKey() == 0` settles regardless; and with
 * every gate open the settles are the ones the tick always sent.
 *
 * The registry half: `v1RunOff: true` must render `SOLO_WIND_DOWN=1` and nothing else, `false` and
 * absent must render the same bytes, the committed files must be the render of the committed flag
 * (absent before the owner's v1 freeze, true after it: flipping it is a registry edit, not a code
 * change, so the test holds on both sides), and the line must parse into this config.
 *
 * HOW: the technique of roll.vol.test.ts. The keeper's own client methods are replaced per test and
 * restored after; the RPC is a discard port; ALERT_WEBHOOK is unset, so alerts land in SQLite.
 * KEEPER_PRICING_MODE=fixed, so the flag-off tick prices from the stubbed feed and never reaches for
 * Cboe. ops/keeper-env.sh is run on a scratch copy of the real registry into a scratch directory;
 * the committed env files are only read. Like web/lib/markets.test.ts, this needs ops/ in the
 * checkout.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const FACTORY = '0x2222222222222222222222222222222222222222';
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-solo-winddown-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
delete process.env.VAULT;
process.env.FACTORY = FACTORY;
process.env.KEEPER_MARKET = 'NVDA';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
process.env.KEEPER_PRICING_MODE = 'fixed';
process.env.SOLO_WIND_DOWN = '1';
delete process.env.ALERT_WEBHOOK;
for (const key of ['PRICE_FEED', 'KEEPER_MIN_ASK_USDG6', 'KEEPER_STRIKE_OTM_BPS', 'KEEPER_ARM_LEAD_S', 'KEEPER_NYSE_HOLIDAYS', 'WIND_DOWN']) {
  delete process.env[key];
}

const { parse: parseDotenv } = await import('dotenv');
const { clearAlert } = await import('./alerts.js');
const { publicClient, walletClient } = await import('./clients.js');
const { config, loadConfig } = await import('./config.js');
const { buildApp } = await import('./health.js');
const { tickSolo } = await import('./solo.js');
const { store } = await import('./state.js');

const ZERO32 = `0x${'00'.repeat(32)}` as const;
const DAY = 86_400;
const DRAINED_KEY = `solo_v1_drained:${FACTORY}`;

/** Writer accounts (clones) and their owners. Digits only, so no checksum casing to match. */
const W1 = '0x1000000000000000000000000000000000000001';
const W2 = '0x1000000000000000000000000000000000000002';
const W3 = '0x1000000000000000000000000000000000000003';
const W4 = '0x1000000000000000000000000000000000000004';
const ownerOf = (writer: string | undefined) => `0x90${String(writer).slice(4)}`;

test.after(() => {
  store.close();
});

/*//////////////////////////////////////////////////////////////
                              STUBS
//////////////////////////////////////////////////////////////*/

interface Call {
  address?: string;
  functionName: string;
  args?: readonly unknown[];
}

/** What the factory, its accounts and the feed answer. Mutated by setWeek, like a chain. */
interface Chain {
  now: number;
  week: { id: number; exerciseTs: number; baseExpiryTs: number };
  writesHalted: boolean;
  /** Accounts waiting for `listFor`. */
  pending: string[];
  /** Listed accounts and the expiry each pinned when it listed. */
  live: Array<{ writer: string; expiryTs: number }>;
  balanceWei: bigint;
  /** `account.claimKey()` by writer; absent is 1 (sold: settle() redeems). */
  claimKeys?: Record<string, bigint>;
  /** The transfer gates settle's redeem needs open; absent is all open. */
  gates?: Gates;
}

/** What the issuers answer. Addresses are compared lowercased. */
interface Gates {
  usdgPaused?: boolean;
  assetPaused?: boolean;
  /** Frozen on USDG. */
  usdgFrozen?: string[];
  /** Blocked on the Stock Token's access registry. */
  blocked?: string[];
  /** Reads that revert inside the multicall, by label (`USDG.paused`, `isBlocked(Clear)`,
   *  `claimKey(<writer>)`, ...). */
  failing?: string[];
  /** `ASSET.ACCESS_CONTROLLED_REGISTRY()` reverts. */
  registryFails?: boolean;
  /** The whole multicall throws (every RPC down). */
  multicallThrows?: boolean;
}

const nowS = () => Math.floor(Date.now() / 1000);

let txCount = 0;

/** The Stock Token access registry `ACCESS_CONTROLLED_REGISTRY()` answers in these tests. */
const REGISTRY = '0x7000000000000000000000000000000000000007';
const lc = (a: unknown) => String(a).toLowerCase();

/** The runbook's label for one guard read, from its target and argument. */
function gateLabel(call: Call): string {
  const arg = lc(call.args?.[0]);
  const who = arg === lc(config.CLEARINGHOUSE) ? 'Clear' : 'account';
  const at = lc(call.address);
  if (call.functionName === 'claimKey') return `claimKey(${call.address})`;
  if (call.functionName === 'paused' && at === lc(config.USDG)) return 'USDG.paused';
  if (call.functionName === 'isFrozen' && at === lc(config.USDG)) return `USDG.isFrozen(${who})`;
  if (call.functionName === 'paused' && at === lc(config.ASSET)) return 'ASSET.paused';
  if (call.functionName === 'isBlocked' && at === lc(REGISTRY)) return `isBlocked(${who})`;
  throw new Error(`unstubbed guard read ${call.functionName} on ${call.address}`);
}

function stubChain(chain: Chain) {
  const reads: string[] = [];
  const simulated: string[] = [];
  /** One entry per multicall: each call as `functionName@address(args)`. */
  const multicalls: string[][] = [];
  const gates = (): Gates => chain.gates ?? {};
  const mocks = [
    mock.method(publicClient, 'readContract', async (call: Call) => {
      reads.push(call.functionName);
      const i = Number(call.args?.[0] ?? 0);
      switch (call.functionName) {
        case 'week':
          return [chain.week.id, 222_000_000n, chain.week.exerciseTs, chain.week.baseExpiryTs, 1_000_000n];
        case 'pendingCount':
          return BigInt(chain.pending.length);
        case 'liveCount':
          return BigInt(chain.live.length);
        case 'writesHalted':
          return chain.writesHalted;
        case 'policy':
          return [300, 1200, 40, 9500, 500, 50n];
        case 'maxPriceAge':
          return 345_600;
        case 'KEEPER_ROLE':
          return ZERO32;
        case 'hasRole':
          return true;
        case 'feesEnabled':
          return false;
        case 'feeBps':
          return 15;
        case 'decimals':
          return 8;
        case 'latestRoundData':
          return [7n, 21_221_000_000n, BigInt(chain.now - 60), BigInt(chain.now - 60), 7n];
        case 'pendingAt':
          return chain.pending[i];
        case 'liveAt':
          return chain.live[i]?.writer;
        case 'owner':
          return ownerOf(call.address);
        case 'listedExpiryTs':
          return chain.live.find((l) => l.writer === call.address)?.expiryTs ?? 0;
        case 'ACCESS_CONTROLLED_REGISTRY':
          if (gates().registryFails) throw new Error('execution reverted');
          return REGISTRY;
        default:
          throw new Error(`unstubbed read ${call.functionName}`);
      }
    }),
    mock.method(publicClient, 'multicall', async ({ contracts, allowFailure }: { contracts: Call[]; allowFailure?: boolean }) => {
      assert.equal(allowFailure, true, 'a gate that reverts must come back as a failed read, not throw the batch');
      multicalls.push(contracts.map((c) => `${c.functionName}@${c.address}${c.args ? `(${c.args.join(',')})` : ''}`));
      const g = gates();
      if (g.multicallThrows) throw new Error('HTTP request failed: every RPC is down');
      return contracts.map((c) => {
        const label = gateLabel(c);
        if ((g.failing ?? []).includes(label)) return { status: 'failure', error: new Error('execution reverted'), result: undefined };
        const arg = lc(c.args?.[0]);
        switch (label.replace(/\(0x[0-9a-fA-F]+\)$/, '')) {
          case 'claimKey':
            return { status: 'success', result: chain.claimKeys?.[String(c.address)] ?? 1n };
          case 'USDG.paused':
            return { status: 'success', result: g.usdgPaused ?? false };
          case 'ASSET.paused':
            return { status: 'success', result: g.assetPaused ?? false };
          case 'USDG.isFrozen(account)':
          case 'USDG.isFrozen(Clear)':
            return { status: 'success', result: (g.usdgFrozen ?? []).map(lc).includes(arg) };
          default:
            return { status: 'success', result: (g.blocked ?? []).map(lc).includes(arg) };
        }
      });
    }),
    mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: BigInt(chain.now) })),
    mock.method(publicClient, 'getBalance', async () => chain.balanceWei),
    mock.method(publicClient, 'simulateContract', async (call: Call) => {
      // settle is sent to the account, setWeek and listFor to the factory.
      const target = call.functionName === 'listFor' ? String(call.args?.[0]) : call.functionName === 'settle' ? String(call.address) : '';
      simulated.push(target === '' ? call.functionName : `${call.functionName}:${target}`);
      return { request: call };
    }),
    mock.method(walletClient, 'writeContract', async (call: Call) => {
      if (call.functionName === 'setWeek') {
        chain.week = { id: chain.week.id + 1, exerciseTs: Number(call.args?.[1]), baseExpiryTs: Number(call.args?.[2]) };
      }
      if (call.functionName === 'settle') {
        // AccountFactory.notifySettled: the account leaves the live set.
        chain.live = chain.live.filter((l) => l.writer !== call.address);
      }
      txCount += 1;
      return `0x${txCount.toString(16).padStart(64, '0')}`;
    }),
    mock.method(publicClient, 'waitForTransactionReceipt', async ({ hash }: { hash: string }) => ({
      status: 'success',
      blockNumber: 1_000n,
      gasUsed: 100_000n,
      transactionHash: hash,
      logs: [],
    })),
  ];
  return { reads, simulated, multicalls, restore: () => mocks.forEach((m) => m.mock.restore()) };
}

/** The week has passed its base expiry: a flag-off keeper would set the next one. Both listed
 *  accounts are past their expiry and settleable; two more wait to list. The factory is frozen. */
function expiredWeek(now: number): Chain {
  return {
    now,
    week: { id: 3, exerciseTs: now - 2 * DAY, baseExpiryTs: now - DAY },
    writesHalted: true,
    pending: [W1, W2],
    live: [
      { writer: W3, expiryTs: now - DAY },
      { writer: W4, expiryTs: now - DAY },
    ],
    balanceWei: 10n ** 18n,
  };
}

/** A current week with writes NOT halted (a freeze that only capped deposits): a flag-off keeper
 *  would list both pending accounts. The one live account has not expired. */
function currentWeek(now: number): Chain {
  return {
    now,
    week: { id: 4, exerciseTs: now + 2 * DAY, baseExpiryTs: now + 3 * DAY },
    writesHalted: false,
    pending: [W1, W2],
    live: [{ writer: W3, expiryTs: now + 3 * DAY }],
    balanceWei: 10n ** 18n,
  };
}

function lastAlertId(): number {
  return (store.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM alerts').get() as { n: number }).n;
}

function alertsSince(id: number): Array<{ kind: string; severity: string; message: string; delivered: number; data: Record<string, unknown> }> {
  return (
    store.db.prepare('SELECT kind, severity, message, delivered, data_json FROM alerts WHERE id > ? ORDER BY id').all(id) as Array<{
      kind: string;
      severity: string;
      message: string;
      delivered: number;
      data_json: string | null;
    }>
  ).map((a) => ({ ...a, data: a.data_json === null ? {} : (JSON.parse(a.data_json) as Record<string, unknown>) }));
}

/** Run `fn` with the process config patched, restoring it after. config.ts reads the environment
 *  once at import, so this is how one file ticks both sides of the flag. */
async function withConfig(patch: Partial<typeof config>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k as keyof typeof config]]));
  Object.assign(config, patch);
  try {
    await fn();
  } finally {
    Object.assign(config, saved);
  }
}

/*//////////////////////////////////////////////////////////////
                    NO WEEK, NO LISTS, STILL SETTLES
//////////////////////////////////////////////////////////////*/

test('run-off: an expired week is not replaced, pending accounts are not listed, and every expired account is settled', async () => {
  assert.equal(config.SOLO_WIND_DOWN, true);
  assert.equal(config.VAULT, undefined, 'a factory-only process');
  const now = nowS();

  let chain = stubChain(expiredWeek(now));
  let before = lastAlertId();
  try {
    await tickSolo();
    assert.deepEqual(chain.simulated, [`settle:${W3}`, `settle:${W4}`], 'no setWeek, no listFor: only the two settles');
    assert.ok(!chain.reads.includes('pendingAt') && !chain.reads.includes('owner'), 'the pending queue is not even walked');
    const kinds = alertsSince(before).map((a) => a.kind);
    for (const kind of ['week_set', 'cycle_not_created', 'tx_revert', 'v1_drained']) {
      assert.ok(!kinds.includes(kind), `no ${kind}: ${kinds.join(', ')}`);
    }
    const settles = store.db.prepare("SELECT COUNT(*) AS n FROM txs WHERE kind = 'settle' AND status = 'success'").get() as { n: number };
    assert.equal(settles.n, 2, 'both settles recorded like any other factory transaction');
  } finally {
    chain.restore();
  }

  // Writes not halted and a current week: listFor would succeed, and still nothing is listed.
  chain = stubChain(currentWeek(now));
  before = lastAlertId();
  try {
    await tickSolo();
    assert.deepEqual(chain.simulated, [], 'nothing expired, nothing to list in run-off');
    assert.ok(!chain.reads.includes('pendingAt') && !chain.reads.includes('owner'));
    assert.equal(chain.reads.filter((r) => r === 'listedExpiryTs').length, 1, 'settleExpired still looked at the live account');
    assert.ok(!alertsSince(before).some((a) => a.kind === 'v1_drained'), 'two pending and one live is not drained');
  } finally {
    chain.restore();
  }
});

test('the same chain with SOLO_WIND_DOWN off sets the week and lists: the flag is what stops both', async () => {
  const now = nowS();
  await withConfig({ SOLO_WIND_DOWN: false }, async () => {
    let chain = stubChain(expiredWeek(now));
    let before = lastAlertId();
    try {
      await tickSolo();
      assert.deepEqual(chain.simulated, ['setWeek', `settle:${W3}`, `settle:${W4}`]);
      assert.ok(alertsSince(before).some((a) => a.kind === 'week_set'));
    } finally {
      chain.restore();
    }

    chain = stubChain(currentWeek(now));
    try {
      await tickSolo();
      assert.deepEqual(chain.simulated, [`listFor:${ownerOf(W1)}`, `listFor:${ownerOf(W2)}`]);
    } finally {
      chain.restore();
    }

    // A factory with nothing live or pending is not "drained" outside run-off: nothing is said or kept.
    const empty = { ...currentWeek(now), pending: [], live: [] };
    chain = stubChain(empty);
    before = lastAlertId();
    try {
      await tickSolo();
      assert.ok(!alertsSince(before).some((a) => a.kind === 'v1_drained'));
      assert.equal(store.getMeta(DRAINED_KEY), null);
    } finally {
      chain.restore();
    }
  });
});

test('run-off keeps the health side: low_gas still pages, the loop still beats, /health and /state say windDown', async () => {
  const now = nowS();
  const chain = stubChain({ ...currentWeek(now), balanceWei: 1n });
  const before = lastAlertId();
  const started = Date.now();
  try {
    await tickSolo();
    assert.ok(alertsSince(before).some((a) => a.kind === 'low_gas'), 'the health alerts are raised before the run-off branch');
    assert.ok((store.lastHeartbeat() ?? 0) >= started, 'tickSolo beat on the way out');

    const app = buildApp();
    const health = (await (await app.request('/health')).json()) as Record<string, any>;
    assert.equal(health.factory.windDown, true);
    assert.equal(health.factory.pendingCount, 2);
    const state = (await (await app.request('/state')).json()) as Record<string, any>;
    assert.equal(state.windDown, true);
    assert.equal(state.nextWeek, null, 'no next week is advertised: the keeper will never set one');
    assert.equal(state.drainedAt, null);
  } finally {
    chain.restore();
    clearAlert('low_gas');
  }
});

/*//////////////////////////////////////////////////////////////
                             DRAINED
//////////////////////////////////////////////////////////////*/

test('drained: v1_drained goes out once per factory, a failed delivery is retried rather than marked, and a restart does not repeat it', async () => {
  const now = nowS();
  const chain: Chain = { ...currentWeek(now), pending: [W1], live: [] };
  const stub = stubChain(chain);
  const drained = (since: number) => alertsSince(since).filter((a) => a.kind === 'v1_drained');
  try {
    // One pending account, nothing live: not drained. Then one live, nothing pending: not drained.
    let before = lastAlertId();
    await tickSolo();
    chain.pending = [];
    chain.live = [{ writer: W3, expiryTs: now + DAY }];
    await tickSolo();
    assert.deepEqual(drained(before), []);

    // Drained, and the webhook refuses the POST: the alert is stored undelivered and nothing is marked.
    chain.live = [];
    before = lastAlertId();
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 502 }));
    try {
      await withConfig({ ALERT_WEBHOOK: 'http://127.0.0.1:9/alert' }, () => tickSolo());
    } finally {
      fetchMock.mock.restore();
    }
    assert.equal(fetchMock.mock.callCount(), 1);
    const failed = drained(before);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.delivered, 0);
    assert.equal(store.getMeta(DRAINED_KEY), null, 'a failed delivery is not remembered as said');

    // The next tick is inside the failed delivery's five-minute retry window: not every tick.
    before = lastAlertId();
    await tickSolo();
    assert.deepEqual(drained(before), []);
    assert.equal(store.getMeta(DRAINED_KEY), null);

    // Five minutes later (the cooldown cleared): delivered, and marked.
    clearAlert('v1_drained', FACTORY);
    before = lastAlertId();
    await tickSolo();
    const sent = drained(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.severity, 'info');
    assert.match(sent[0]?.message ?? '', /^NVDA v1 market drained: factory 0x2222222222222222222222222222222222222222 has no live or pending account/);
    assert.equal(sent[0]?.data.factory, FACTORY);
    assert.equal(sent[0]?.data.liveCount, 0);
    assert.equal(sent[0]?.data.pendingCount, 0);
    const markedAt = store.getMeta(DRAINED_KEY);
    assert.ok(markedAt !== null && !Number.isNaN(Date.parse(markedAt)), 'the SQLite marker holds when it was said');

    // Every later tick, and a restart (no cooldown memory, same database): silence, from the marker.
    before = lastAlertId();
    await tickSolo();
    clearAlert('v1_drained', FACTORY);
    await tickSolo();
    assert.deepEqual(drained(before), []);
    assert.equal(store.getMeta(DRAINED_KEY), markedAt);

    const state = (await (await buildApp().request('/state')).json()) as Record<string, any>;
    assert.equal(state.drainedAt, markedAt);
  } finally {
    stub.restore();
  }
});

/*//////////////////////////////////////////////////////////////
                          THE SETTLE GUARD
//////////////////////////////////////////////////////////////*/

type Held = { account: string; claimKey: string | null; listedExpiryTs: number; reasons: string[]; since: string };

async function settleHeld(): Promise<Held[]> {
  const state = (await (await buildApp().request('/state')).json()) as Record<string, any>;
  return state.settleHeld as Held[];
}

const heldAlerts = (since: number) => alertsSince(since).filter((a) => a.kind === 'v1_settle_held');

/** Three expired accounts: W3 sold (claimKey 7), W4 sold nothing (claimKey 0), W1 sold (claimKey 5). */
function dueAccounts(now: number, gates: Gates): Chain {
  return {
    ...currentWeek(now),
    pending: [],
    live: [
      { writer: W3, expiryTs: now - 60 },
      { writer: W4, expiryTs: now - 60 },
      { writer: W1, expiryTs: now - 60 },
    ],
    claimKeys: { [W3]: 7n, [W4]: 0n, [W1]: 5n },
    gates,
  };
}

test('settle guard: the multicall is settle_safe\'s six reads plus claimKey, one per due account, against USDG, the Stock Token and its registry', async () => {
  const now = nowS();
  const chain: Chain = { ...dueAccounts(now, {}), live: [{ writer: W3, expiryTs: now - 60 }, { writer: W4, expiryTs: now + DAY }] };
  const stub = stubChain(chain);
  try {
    await tickSolo();
    assert.deepEqual(stub.simulated, [`settle:${W3}`], 'every gate open: settled as always; W4 is not due');
    assert.deepEqual(stub.multicalls, [
      [
        `claimKey@${W3}`,
        `paused@${config.USDG}`,
        `isFrozen@${config.USDG}(${W3})`,
        `isFrozen@${config.USDG}(${config.CLEARINGHOUSE})`,
        `paused@${config.ASSET}`,
        `isBlocked@${REGISTRY}(${W3})`,
        `isBlocked@${REGISTRY}(${config.CLEARINGHOUSE})`,
      ],
    ]);
    assert.equal(stub.reads.filter((r) => r === 'ACCESS_CONTROLLED_REGISTRY').length, 1, 'the registry is asked once, and only because an account was due');
    assert.deepEqual(await settleHeld(), []);
  } finally {
    stub.restore();
  }
});

test('settle guard: each shut gate holds every sold account it touches, alerts v1_settle_held once per account, sends nothing for them, and settles them once it opens', async () => {
  const cases: Array<{ reason: string; gates: Gates; global: boolean; phrase: RegExp }> = [
    { reason: 'usdg_paused', gates: { usdgPaused: true }, global: true, phrase: /USDG is paused/ },
    { reason: 'usdg_frozen', gates: { usdgFrozen: [W3] }, global: false, phrase: /the account is frozen on USDG/ },
    { reason: 'clear_usdg_frozen', gates: { usdgFrozen: [config.CLEARINGHOUSE] }, global: true, phrase: /the Valorem Clear 0x[0-9a-fA-F]{40} is frozen on USDG/ },
    { reason: 'asset_paused', gates: { assetPaused: true }, global: true, phrase: /the NVDA Stock Token is paused/ },
    { reason: 'asset_blocked', gates: { blocked: [W3] }, global: false, phrase: /the account is blocked on the NVDA Stock Token/ },
    { reason: 'clear_asset_blocked', gates: { blocked: [config.CLEARINGHOUSE] }, global: true, phrase: /the Valorem Clear 0x[0-9a-fA-F]{40} is blocked on the NVDA Stock Token/ },
  ];
  for (const c of cases) {
    const now = nowS();
    const chain = dueAccounts(now, c.gates);
    const stub = stubChain(chain);
    try {
      const held = c.global ? [W3, W1] : [W3];
      let before = lastAlertId();
      await tickSolo();
      // W4 has claimKey 0: no redeem, so it settles whatever the gates say.
      assert.deepEqual(stub.simulated, c.global ? [`settle:${W4}`] : [`settle:${W4}`, `settle:${W1}`], c.reason);
      const alerts = heldAlerts(before);
      assert.deepEqual(alerts.map((a) => a.data.account), held, `${c.reason}: one alert per held account`);
      for (const a of alerts) {
        assert.equal(a.severity, 'warn');
        assert.equal(a.data.reason, c.reason);
        assert.match(a.message, /^NVDA settle\(\) held for account 0x100000000000000000000000000000000000000[13] \(claimKey [57]\): /);
        assert.match(a.message, c.phrase);
        assert.deepEqual(a.data.failedReads, []);
      }
      assert.equal(alerts[0]?.data.claimKey, '7');
      assert.ok(!alertsSince(before).some((a) => a.kind === 'tx_revert'), `${c.reason}: nothing was simulated for a held account, so nothing reverted`);
      assert.deepEqual((await settleHeld()).map((h) => [h.account, h.reasons]), held.map((w) => [w, [c.reason]]));

      // Still shut: skipped again, said nothing again.
      before = lastAlertId();
      stub.simulated.length = 0;
      await tickSolo();
      assert.deepEqual(stub.simulated, [], `${c.reason}: held again`);
      assert.deepEqual(heldAlerts(before), [], `${c.reason}: alerted once, not every tick`);

      // The gate opens: the held accounts settle on the next tick and the hold is forgotten.
      chain.gates = {};
      before = lastAlertId();
      await tickSolo();
      assert.deepEqual(stub.simulated, held.map((w) => `settle:${w}`), `${c.reason}: settled once open`);
      assert.deepEqual(heldAlerts(before), []);
      assert.deepEqual(await settleHeld(), []);
      assert.deepEqual(chain.live, []);
    } finally {
      stub.restore();
    }
  }
});

test('settle guard: a read that fails is a shut gate, never an open one: a reverting gate, the registry address, claimKey, and a multicall that throws', async () => {
  const cases: Array<{ name: string; gates: Gates; held: string[]; settled: string[]; failedReads: string[] }> = [
    { name: 'one gate reverts', gates: { failing: ['USDG.isFrozen(Clear)'] }, held: [W3, W1], settled: [W4], failedReads: ['USDG.isFrozen(Clear)'] },
    {
      name: 'ACCESS_CONTROLLED_REGISTRY reverts',
      gates: { registryFails: true },
      held: [W3, W1],
      settled: [W4],
      failedReads: ['ACCESS_CONTROLLED_REGISTRY', 'isBlocked(account)', 'isBlocked(Clear)'],
    },
    // claimKey 0 settles regardless, but only a claimKey that was READ as 0.
    { name: 'claimKey reverts', gates: { failing: [`claimKey(${W4})`] }, held: [W4], settled: [W3, W1], failedReads: ['claimKey'] },
    {
      name: 'the multicall throws',
      gates: { multicallThrows: true },
      held: [W3, W4, W1],
      settled: [],
      failedReads: ['claimKey', 'USDG.paused', 'USDG.isFrozen(account)', 'USDG.isFrozen(Clear)', 'ASSET.paused', 'isBlocked(account)', 'isBlocked(Clear)'],
    },
  ];
  for (const c of cases) {
    const now = nowS();
    const chain = dueAccounts(now, c.gates);
    const stub = stubChain(chain);
    try {
      let before = lastAlertId();
      await tickSolo();
      assert.deepEqual(stub.simulated, c.settled.map((w) => `settle:${w}`), c.name);
      const alerts = heldAlerts(before);
      assert.deepEqual(alerts.map((a) => a.data.account), c.held, `${c.name}: one read_failed alert per held account`);
      for (const a of alerts) {
        assert.equal(a.data.reason, 'read_failed');
        assert.deepEqual(a.data.failedReads, c.failedReads, c.name);
        assert.match(a.message, /a safety read did not answer \(.+\), which counts as unsafe/);
      }
      if (c.name === 'claimKey reverts') assert.match(alerts[0]?.message ?? '', /\(claimKey unread\)/);

      before = lastAlertId();
      stub.simulated.length = 0;
      await tickSolo();
      assert.deepEqual(stub.simulated, [], `${c.name}: still held`);
      assert.deepEqual(heldAlerts(before), [], `${c.name}: once`);

      chain.gates = {};
      await tickSolo();
      assert.deepEqual(stub.simulated, c.held.map((w) => `settle:${w}`), `${c.name}: the reads answer again and the accounts settle`);
      assert.deepEqual(await settleHeld(), []);
    } finally {
      stub.restore();
    }
  }
});

test('settle guard: a reason that clears is forgotten while another holds, and a hold lifted by a settle alerts again when the account is held next time', async () => {
  const now = nowS();
  const chain: Chain = { ...dueAccounts(now, { usdgPaused: true }), live: [{ writer: W3, expiryTs: now - 60 }] };
  const stub = stubChain(chain);
  const reasons = (since: number) => heldAlerts(since).map((a) => `${a.data.account}:${a.data.reason}`);
  try {
    let before = lastAlertId();
    await tickSolo();
    // USDG unpaused, but the account is frozen: the new reason alerts, the old one is dropped.
    chain.gates = { usdgFrozen: [W3] };
    await tickSolo();
    assert.deepEqual((await settleHeld()).map((h) => h.reasons), [['usdg_frozen']]);
    // USDG paused again on top: said again, because the earlier usdg_paused hold was forgotten.
    chain.gates = { usdgFrozen: [W3], usdgPaused: true };
    await tickSolo();
    assert.deepEqual(reasons(before), [`${W3}:usdg_paused`, `${W3}:usdg_frozen`, `${W3}:usdg_paused`]);
    assert.deepEqual(stub.simulated, []);

    // Every gate open: settled. A week later the same account is listed again, due, and USDG is paused.
    chain.gates = {};
    await tickSolo();
    assert.deepEqual(stub.simulated, [`settle:${W3}`]);
    chain.live = [{ writer: W3, expiryTs: now - 30 }];
    chain.gates = { usdgPaused: true };
    before = lastAlertId();
    await tickSolo();
    assert.deepEqual(reasons(before), [`${W3}:usdg_paused`], 'the lifted hold left no cooldown behind');
    chain.gates = {};
    await tickSolo();
    assert.deepEqual(stub.simulated, [`settle:${W3}`, `settle:${W3}`]);
  } finally {
    stub.restore();
  }
});

test('settle guard: a held account someone else settles is forgotten, and the rest of the tick is not held up by it', async () => {
  const now = nowS();
  const chain = dueAccounts(now, { usdgPaused: true });
  const stub = stubChain(chain);
  try {
    await tickSolo();
    assert.deepEqual((await settleHeld()).map((h) => h.account), [W3, W1]);
    // A third party settles W3 (permissionless); W1 stays held.
    chain.live = chain.live.filter((l) => l.writer !== W3);
    await tickSolo();
    assert.deepEqual((await settleHeld()).map((h) => h.account), [W1]);
    chain.live = [];
    await tickSolo();
    assert.deepEqual(await settleHeld(), [], 'nothing live: every hold is dropped');
    assert.deepEqual(stub.simulated, [`settle:${W4}`]);
  } finally {
    stub.restore();
  }
});

test('settle guard with SOLO_WIND_DOWN off: the same hold in the normal factory tick, and the same settles once the gate opens', async () => {
  const now = nowS();
  await withConfig({ SOLO_WIND_DOWN: false }, async () => {
    const chain: Chain = { ...expiredWeek(now), pending: [], gates: { blocked: [config.CLEARINGHOUSE] } };
    const stub = stubChain(chain);
    try {
      const before = lastAlertId();
      await tickSolo();
      assert.deepEqual(stub.simulated, ['setWeek'], 'the week is still set; neither sold account is settled');
      assert.deepEqual(heldAlerts(before).map((a) => [a.data.account, a.data.reason]), [
        [W3, 'clear_asset_blocked'],
        [W4, 'clear_asset_blocked'],
      ]);
      chain.gates = {};
      stub.simulated.length = 0;
      await tickSolo();
      assert.deepEqual(stub.simulated, [`settle:${W3}`, `settle:${W4}`]);
      assert.deepEqual(await settleHeld(), []);
    } finally {
      stub.restore();
    }
  });
});

/*//////////////////////////////////////////////////////////////
                  THE REGISTRY FLAG, INTO THIS CONFIG
//////////////////////////////////////////////////////////////*/

test('registry v1RunOff: true renders SOLO_WIND_DOWN=1 and nothing else, false and absent render the same files, the committed files follow the committed flag, and the keeper reads the line', () => {
  const ops = (rel: string) => fileURLToPath(new URL(`../../ops/${rel}`, import.meta.url));
  const script = ops('keeper-env.sh');
  const real = JSON.parse(readFileSync(ops('markets/tier1.json'), 'utf8')) as { markets: Array<Record<string, any>> };
  // What ops/keeper-env.sh renders: superseded-by-v2 rows (ADR-02) keep their no-factory file.
  const rendered = real.markets.filter((m) => ['live', 'planned', 'superseded-by-v2'].includes(m.status));
  const nvda = real.markets.find((m) => m.ticker === 'NVDA');
  assert.ok(nvda?.deployment?.factory, 'NVDA is the live v1 factory');
  const noFactory = rendered.find((m) => !m.deployment?.factory);
  assert.ok(noFactory, 'a planned or superseded market with no factory');
  // The committed flag is absent before the owner-run v1 freeze and true after it
  // (ops/runbooks/v1-runoff.md step 6). Either way it is a registry edit plus a re-render, never code,
  // so this test holds on both sides of the freeze.
  for (const m of real.markets.filter((x) => 'v1RunOff' in x)) {
    assert.equal(typeof m.v1RunOff, 'boolean', `${m.ticker}: committed v1RunOff is a boolean`);
    if (m.v1RunOff) assert.ok(m.deployment?.factory, `${m.ticker}: a frozen market has a factory`);
  }
  const nvdaFrozen = nvda.v1RunOff === true;

  let copies = 0;
  const run = (edit: (m: Record<string, any>) => void, args: string[]) => {
    const registry = structuredClone(real);
    for (const m of registry.markets) edit(m);
    const file = join(scratch, `tier1-${(copies += 1)}.json`);
    writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
    return spawnSync(process.execPath, [script, '--registry', file, ...args], { encoding: 'utf8' });
  };
  /** Every rendered market into a scratch directory; returns a reader by ticker. */
  const renderAll = (edit: (m: Record<string, any>) => void) => {
    const dir = join(scratch, `render-${copies + 1}`);
    const result = run(edit, ['--out', dir]);
    assert.equal(result.status, 0, result.stderr);
    return (ticker: string) => readFileSync(join(dir, `${ticker}.env`), 'utf8');
  };
  const unrendered = (text: string) =>
    text
      .split('\n')
      .filter((l) => !l.startsWith('# rendered '))
      .join('\n');
  const committed = (ticker: string) => readFileSync(ops(`keeper/markets/${ticker}.env`), 'utf8');

  // The committed registry checks clean against the committed files, frozen or not.
  const asIs = run(() => {}, ['--check']);
  assert.equal(asIs.status, 0, asIs.stderr);
  assert.match(asIs.stdout, new RegExp(`^keeper-env --check: ${rendered.length} file\\(s\\) match`));

  // Explicit false renders exactly what absent renders, on every market: false == absent.
  const absent = renderAll((m) => delete m.v1RunOff);
  const allFalse = renderAll((m) => (m.v1RunOff = false));
  for (const m of rendered) assert.equal(unrendered(allFalse(m.ticker)), unrendered(absent(m.ticker)), m.ticker);

  // NVDA true: exactly the run-off block is added to the absent render, and no other market moves.
  const nvdaTrue = renderAll((m) => {
    if (m.ticker === 'NVDA') m.v1RunOff = true;
    else delete m.v1RunOff;
  });
  const nvdaEnv = nvdaTrue('NVDA');
  assert.equal(nvdaEnv.split('\n').filter((l) => l.startsWith('SOLO_WIND_DOWN')).length, 1);
  const block = [
    '# ---- v1 run-off (registry v1RunOff) ----',
    '# The factory is frozen (writesHalted, depositCap 0): never setWeek or listFor. Expired accounts',
    '# are still settled, and v1_drained is alerted once when no account is live or pending.',
    'SOLO_WIND_DOWN=1',
    '',
    '',
  ].join('\n');
  assert.ok(nvdaEnv.includes(block), 'the block, then the blank line before the shared section');
  assert.equal(unrendered(nvdaEnv.replace(block, '')), unrendered(absent('NVDA')), 'nothing else moved');
  assert.equal(unrendered(nvdaTrue(noFactory.ticker)), unrendered(absent(noFactory.ticker)));

  // The committed NVDA file is the render its committed flag asks for, and flipping the flag makes it stale.
  assert.equal(unrendered(committed('NVDA')), unrendered(nvdaFrozen ? nvdaEnv : absent('NVDA')));
  const stale = run((m) => {
    if (m.ticker === 'NVDA') m.v1RunOff = !nvdaFrozen;
  }, ['--check']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /NVDA: differs/);

  // The keeper reads the rendered line; the absent render leaves it off; the committed file follows its flag.
  const key = { KEEPER_PK: `0x${'22'.repeat(32)}` };
  const fromFlipped = loadConfig({ ...parseDotenv(nvdaEnv), ...key });
  assert.equal(fromFlipped.SOLO_WIND_DOWN, true);
  assert.equal(fromFlipped.FACTORY, nvda.deployment.factory);
  assert.equal(fromFlipped.VAULT, undefined, 'still never the pooled vault');
  assert.equal(loadConfig({ ...parseDotenv(absent('NVDA')), ...key }).SOLO_WIND_DOWN, false);
  assert.equal(loadConfig({ ...parseDotenv(committed('NVDA')), ...key }).SOLO_WIND_DOWN, nvdaFrozen);

  // Refused: a value that is not a boolean, and a run-off with no factory to run off.
  const out = join(scratch, 'env-out');
  const notBool = run((m) => {
    if (m.ticker === 'NVDA') m.v1RunOff = 'yes';
  }, ['--tickers', 'NVDA', '--out', out]);
  assert.equal(notBool.status, 2);
  assert.match(notBool.stderr, /NVDA: registry field v1RunOff must be true or false, not "yes"/);
  const orphan = run((m) => {
    if (m.ticker === noFactory.ticker) m.v1RunOff = true;
  }, ['--check']);
  assert.equal(orphan.status, 2);
  assert.match(orphan.stderr, new RegExp(`${noFactory.ticker}: v1RunOff is true but deployment.factory is null`));
});
