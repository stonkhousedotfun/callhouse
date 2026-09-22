/**
 * The HTTP surface of a signing v2 mode (cranker, mm, pricer), following v1's health.ts. Hono on the
 * mode's port (CRANKER_PORT, MM_PORT, PRICER_PORT). The pricing mode serves its own /health on
 * PRICING_PORT (pricing/server.ts).
 *
 *   GET /health  liveness. 503 ONLY when the loop is wedged: no heartbeat for three poll intervals
 *                and no tick in flight (a tick waiting on a receipt is granted KEEPER_TX_TIMEOUT_MS
 *                plus a minute from its latest progress: every send beats, runtime.ts). Whatever reads the code restarts the process on a 503, so a low gas
 *                balance or a lagging RPC, which a restart cannot fix, is `status: "degraded"` on a
 *                200 and pages through the alert webhook instead; so is a latest page the relay did not
 *                take (`checks.alerting`), which no page can report. `starting` during the first three
 *                poll intervals before any chain read.
 *   GET /state   the mode's own view (the cranker's per-step metrics, the MM bot's net delta), 503
 *                until the mode has one.
 *   GET /ready   a mode that mounts readyRoute (the pricer, T-423): READINESS, not liveness, in a body
 *                that is safe to proxy to a public API. See readyBody.
 *   GET /        service, mode and endpoints.
 *
 * The heartbeat is in memory (ModeHealth), not SQLite as in v1: it only has to outlive a request,
 * and a restarted process starts its grace period again anyway.
 *
 * Nothing here writes and nothing needs a secret; RPC URLs are served origin-only because
 * production endpoints embed keys. No host is passed to listen(): `::` where IPv6 exists (Railway's
 * private network), `0.0.0.0` where it does not, as health.ts and the pricing service do.
 */
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { Address } from 'viem';
import type { SigningMode } from './mode.js';
import { INTERFACE_VERSION } from './registry.js';
import { bigintReplacer, type V2Store } from './store.js';

/** One chain read per tick: what /health reports and the gas and lag checks judge. */
export interface ChainProbe {
  headBlock: bigint;
  /** Unix seconds, the head block's. */
  headTimestamp: number;
  rpcLagSeconds: number;
  balanceWei: bigint;
}

/** What the loop tells the health endpoint. Wall-clock milliseconds throughout: this is liveness, not protocol time. */
export class ModeHealth {
  lastBeat: number | null = null;
  tickStartedAt: number | null = null;
  lastChain: ChainProbe | null = null;
  lastTickError: { at: number; message: string } | null = null;
  /** The latest webhook delivery (alerts.ts), or null before any page was sent. */
  lastAlertDelivery: { at: number; ok: boolean; error: string | null } | null = null;
  ticks = 0;

  constructor(readonly startedAt: number = Date.now()) {}

  beat(at: number): void {
    this.lastBeat = at;
  }

  tickStarted(at: number): void {
    this.tickStartedAt = at;
  }

  tickEnded(): void {
    this.tickStartedAt = null;
    this.ticks += 1;
  }

  recordChain(probe: ChainProbe): void {
    this.lastChain = probe;
  }

  recordTickError(at: number, message: string): void {
    this.lastTickError = { at, message };
  }

  recordAlertDelivery(at: number, ok: boolean, error: string | null): void {
    this.lastAlertDelivery = { at, ok, error };
  }
}

export interface HealthLimits {
  pollIntervalMs: number;
  txTimeoutMs: number;
  rpcLagAlertMs: number;
  minGasWei: bigint;
}

export interface HealthVerdict {
  status: 'starting' | 'ok' | 'degraded';
  /** false only when the loop is wedged: the HTTP code is 503. */
  alive: boolean;
  /** alerting: the latest page reached the relay (true before any was sent). */
  checks: { heartbeat: boolean; rpcLag: boolean; gas: boolean; alerting: boolean };
}

/** v1's /health rules over a ModeHealth. Pure. */
export function evaluateHealth(health: ModeHealth, limits: HealthLimits, now: number): HealthVerdict {
  const staleAfterMs = limits.pollIntervalMs * 3;
  // A tick in flight is granted a receipt wait plus a minute from its latest progress (its start, or the last send's beat).
  const lastProgress = health.tickStartedAt === null ? null : Math.max(health.tickStartedAt, health.lastBeat ?? 0);
  const tickActive = lastProgress !== null && now - lastProgress < limits.txTimeoutMs + 60_000;
  const heartbeat =
    tickActive || (health.lastBeat === null ? now - health.startedAt < staleAfterMs : now - health.lastBeat < staleAfterMs);
  const chain = health.lastChain;
  const rpcLag = chain !== null && chain.rpcLagSeconds * 1000 <= limits.rpcLagAlertMs;
  const gas = chain !== null && chain.balanceWei >= limits.minGasWei;
  // A relay that refuses every page (a rotated token, a dead Discord target) is otherwise visible only in the logs.
  const alerting = health.lastAlertDelivery === null || health.lastAlertDelivery.ok;
  // No chain read yet inside the grace window is "starting": a 503 here would restart the process
  // forever without it ever ticking once.
  const booting = chain === null && health.lastBeat === null && now - health.startedAt < staleAfterMs;
  return {
    status: booting ? 'starting' : heartbeat && rpcLag && gas && alerting ? 'ok' : 'degraded',
    alive: booting || heartbeat,
    checks: { heartbeat, rpcLag, gas, alerting },
  };
}

function originOnly(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unparseable';
  }
}

export interface HealthAppOptions {
  mode: SigningMode;
  health: ModeHealth;
  limits: HealthLimits;
  chainId: number;
  rpcUrls: readonly string[];
  signer: Address;
  contracts: Record<string, Address | null>;
  store: V2Store | null;
  /** The mode's /state body, or null before it has one. */
  state?: () => unknown;
  /** Extra routes of the mode (the MM bot's POST /kill and /resume), mounted before `/`. */
  routes?: { mount: (app: Hono) => void; endpoints: readonly string[] };
  now?: () => number;
}

/** JSON with bigints as strings: Hono's c.json would throw on the first one. */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, bigintReplacer), { status, headers: { 'content-type': 'application/json' } });
}

export function createModeHealthApp(options: HealthAppOptions): Hono {
  const now = options.now ?? Date.now;
  const app = new Hono();
  const rpc = options.rpcUrls.map(originOnly);

  app.get('/health', () => {
    const t = now();
    const h = options.health;
    const verdict = evaluateHealth(h, options.limits, t);
    return json(
      {
        status: verdict.status,
        checks: verdict.checks,
        mode: options.mode,
        uptimeSeconds: Math.floor((t - h.startedAt) / 1000),
        ticks: h.ticks,
        lastHeartbeat: h.lastBeat === null ? null : new Date(h.lastBeat).toISOString(),
        lastHeartbeatAgeSeconds: h.lastBeat === null ? null : Math.floor((t - h.lastBeat) / 1000),
        tickInFlight: h.tickStartedAt !== null,
        lastTickError: h.lastTickError === null ? null : { at: new Date(h.lastTickError.at).toISOString(), message: h.lastTickError.message },
        lastAlertDelivery: h.lastAlertDelivery === null ? null : { at: new Date(h.lastAlertDelivery.at).toISOString(), ok: h.lastAlertDelivery.ok, error: h.lastAlertDelivery.error },
        chain: {
          chainId: options.chainId,
          rpc,
          headBlock: h.lastChain?.headBlock ?? null,
          headTimestamp: h.lastChain?.headTimestamp ?? null,
          rpcLagSeconds: h.lastChain?.rpcLagSeconds ?? null,
        },
        signer: { address: options.signer, balanceWei: h.lastChain?.balanceWei ?? null, minBalanceWei: options.limits.minGasWei },
        contracts: options.contracts,
        db: options.store === null ? null : { path: options.store.path, rows: options.store.counts() },
      },
      verdict.alive ? 200 : 503,
    );
  });

  app.get('/state', () => {
    const state = options.state?.() ?? null;
    if (state === null) return json({ error: 'no state yet; the first tick has not completed', mode: options.mode }, 503);
    return json(state, 200);
  });

  options.routes?.mount(app);

  app.get('/', () => json({ service: `callhouse-${options.mode}`, mode: options.mode, endpoints: ['/health', '/state', ...(options.routes?.endpoints ?? [])] }, 200));

  return app;
}

/*//////////////////////////////////////////////////////////////
                  GET /ready: READINESS, PUBLIC-SAFE
//////////////////////////////////////////////////////////////*/

/**
 * Why a mode is not ready (T-423). A CLOSED set: readyBody replaces anything outside it with
 * `state-unknown`, so a consumer (the indexer, T-424) can switch over it exhaustively and never has to
 * guess what a new string means. The pricer's four conditions (pricer.ts evaluatePricerReadiness) map
 * onto it as: loop alive -> loop-wedged; a tick completed -> no-completed-tick, tick-failed; the reprice
 * authority -> role-unread, role-refused, role-delayed; a qualified fair value -> fair-stale.
 */
export const READY_REASONS = [
  /** The loop is not alive by /health's own rule (evaluateHealth().alive): /health would answer 503. */
  'loop-wedged',
  /** No tick has completed since the process started. */
  'no-completed-tick',
  /** The latest tick threw, so whatever it would have read is unknown. */
  'tick-failed',
  /** No answer to the authority read: never read, or the latest read failed. Unknown is not ready. */
  'role-unread',
  /** The authority read answered no. */
  'role-refused',
  /** The authority read answered with a non-zero execution delay: every call would need scheduling. */
  'role-delayed',
  /** No qualified fair value within the mode's bound, or none at all. */
  'fair-stale',
  /** The evaluation threw, or returned something outside this set or not a boolean. */
  'state-unknown',
] as const;
export type ReadyReason = (typeof READY_REASONS)[number];

/** What a mode's readiness rule returns. `lastEvaluationAt` is wall-clock milliseconds, or null. */
export interface Readiness {
  ready: boolean;
  reasons: readonly ReadyReason[];
  lastEvaluationAt: number | null;
}

/**
 * The GET /ready body: these five keys and nothing else. /health's body carries the signer and its
 * balance, the RPC origins, the contract addresses and the db path, which is why nothing may proxy it to
 * a public API; this one is built key by key from the Readiness, so a field added to the rule's result
 * can never reach it.
 */
export interface ReadyBody {
  ready: boolean;
  reasons: ReadyReason[];
  /** ISO time of this answer (wall clock). */
  checkedAt: string;
  /** ISO time of the mode's latest completed evaluation (wall clock), or null before the first. */
  lastEvaluationAt: string | null;
  /** The contract interface this keeper implements (registry.ts INTERFACE_VERSION). */
  interfaceVersion: number;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(READY_REASONS);

function isReadiness(value: unknown): value is Readiness {
  return typeof value === 'object' && value !== null && typeof (value as Readiness).ready === 'boolean' && Array.isArray((value as Readiness).reasons);
}

/**
 * FAIL CLOSED. `ready` is true only when the rule returned exactly `true` AND named no reason against it.
 * A rule that throws, returns a non-boolean `ready`, a reason outside READY_REASONS, or `ready: false`
 * with no reason at all yields `ready: false` with `state-unknown`: there is no path by which not knowing
 * becomes ready, and no path by which not-ready arrives without a reason.
 */
export function readyBody(evaluate: (now: number) => Readiness, now: number): ReadyBody {
  let result: unknown;
  try {
    result = evaluate(now);
  } catch {
    result = null;
  }
  const verdict = isReadiness(result) ? result : null;
  const reasons: ReadyReason[] = [];
  let unknown = verdict === null;
  for (const reason of verdict?.reasons ?? []) {
    if (!KNOWN_REASONS.has(reason)) unknown = true;
    else if (!reasons.includes(reason)) reasons.push(reason);
  }
  const ready = !unknown && verdict?.ready === true && reasons.length === 0;
  if (!ready && (unknown || reasons.length === 0) && !reasons.includes('state-unknown')) reasons.push('state-unknown');
  const at = verdict?.lastEvaluationAt;
  return {
    ready,
    reasons,
    checkedAt: new Date(now).toISOString(),
    lastEvaluationAt: typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : null,
    interfaceVersion: INTERFACE_VERSION,
  };
}

/**
 * GET /ready as a mode route (ModeDefinition.routes): 200 when ready, 503 when not, the body either way.
 * The status agrees with the body so a consumer that reads only the code also fails closed.
 *
 * NEVER point a restart healthcheck (railway.json healthcheckPath) at /ready. Not-ready includes causes a
 * restart cannot fix - a revoked role, a pricing service that is down, a closed market leaving no fair
 * value inside the bound - and a restart on those is the crash loop /health's rules exist to avoid.
 */
export function readyRoute(evaluate: (now: number) => Readiness, now: () => number = Date.now): { mount: (app: Hono) => void; endpoints: readonly string[] } {
  return {
    mount: (app) => {
      app.get('/ready', () => {
        const body = readyBody(evaluate, now());
        return json(body, body.ready ? 200 : 503);
      });
    },
    endpoints: ['/ready'],
  };
}

export interface RunningServer {
  server: ServerType;
  /** The bound port (the requested one, or the OS's choice for 0). */
  port: number;
  close(): Promise<void>;
}

/** Listen on `port` (no host: see the header) and resolve once bound. */
export async function serveApp(app: Hono, port: number): Promise<RunningServer> {
  const server = await new Promise<ServerType>((resolveServer, reject) => {
    const s = serve({ fetch: app.fetch, port }, () => resolveServer(s));
    s.once('error', reject);
  });
  const address = server.address();
  return {
    server,
    port: typeof address === 'object' && address !== null ? address.port : port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
