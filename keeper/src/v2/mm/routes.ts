/**
 * The MM bot's kill switch on its health port (MM_PORT): POST /kill and POST /resume.
 *
 *   POST /kill     Authorization: Bearer <MM_KILL_TOKEN>, optional JSON { "reason": "...", "vault": "0x..." }
 *                  No vault (or empty body) still kills EVERY vault. `{ "vault": "0x.." }` kills one.
 *                  → 200 { killed: true, at, reason, cancelled, remaining: 0, remainingOrderIds: [], done: true }
 *                    once no vault order is live or holds escrow (an expired Bid or AskResale);
 *                    202 { ..., done: false } when the cancels take longer than a minute (they carry on;
 *                    remaining -1), or when orders are left after every cancel pass (remaining, their
 *                    ids, and why in errors; every later tick keeps cancelling them). The killed state
 *                    is stored (v2_meta), so a restart stays killed: the bot places nothing until
 *                    POST /resume.
 *   POST /resume   same auth → 200 { killed: false }.
 *   anything else on those paths, or a missing / wrong token → 401 { error: "unauthorized" } (the same
 *                  body whatever was wrong; the token is never echoed or logged). GET → 405.
 *
 * PRIVATE NETWORK ONLY. mm-bot never gets a public domain (ops/deploy.md §15): the token is the second
 * lock, not the first. The comparison is constant-time over SHA-256 digests, so neither the token's
 * length nor a matching prefix shows in the response time.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { bigintReplacer } from '../store.js';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** True when `header` is exactly `Bearer <token>`. Constant-time in the token. */
export function bearerMatches(header: string | undefined | null, token: string): boolean {
  if (token.length === 0) return false;
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Always compare, even for a missing header: the time does not say which case it was.
  const equal = timingSafeEqual(digest(presented), digest(token));
  return equal && presented.length > 0;
}

export interface KillOutcome {
  killed: true;
  at: number;
  reason: string;
  cancelled: number;
  /** Vault orders still live or holding escrow after the cancel passes; -1 when unknown (still running, chain down). */
  remaining: number;
  remainingOrderIds: bigint[];
  done: boolean;
  errors: string[];
}

export interface KillSwitch {
  kill(reason: string, vault?: string): Promise<KillOutcome>;
  /**
   * Releases a kill and reports the scope's REAL state afterwards: `killed: true` with `stillKilled` when a
   * wider kill is still engaged (F-DAPP-08). It used to answer a flat false without asking.
   */
  resume(vault?: string): { killed: boolean; at: number; stillKilled?: { at: number; reason: string } };
}

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body, bigintReplacer), { status, headers: { 'content-type': 'application/json' } });

/** Mount /kill and /resume on the mode's health app. */
export function mountKillRoutes(app: Hono, options: { token: () => string; target: KillSwitch; log?: { warn(obj: object, msg: string): void } }): void {
  const unauthorized = () => json({ error: 'unauthorized' }, 401);

  app.post('/kill', async (c) => {
    if (!bearerMatches(c.req.header('authorization'), options.token())) {
      options.log?.warn({ path: '/kill' }, 'kill switch: unauthorized request refused');
      return unauthorized();
    }
    let reason = 'POST /kill';
    let vault: string | undefined;
    try {
      const body = (await c.req.json()) as { reason?: unknown; vault?: unknown };
      if (typeof body?.reason === 'string' && body.reason.trim() !== '') reason = body.reason.trim().slice(0, 200);
      if (typeof body?.vault === 'string' && body.vault.trim() !== '') vault = body.vault.trim();
    } catch {
      // No body, or not JSON: the default reason, every vault.
    }
    const outcome = await options.target.kill(reason, vault);
    return json(outcome, outcome.done ? 200 : 202);
  });

  app.post('/resume', async (c) => {
    if (!bearerMatches(c.req.header('authorization'), options.token())) {
      options.log?.warn({ path: '/resume' }, 'kill switch: unauthorized request refused');
      return unauthorized();
    }
    let vault: string | undefined;
    try {
      const body = (await c.req.json()) as { vault?: unknown };
      if (typeof body?.vault === 'string' && body.vault.trim() !== '') vault = body.vault.trim();
    } catch {
      // No body: resume every vault.
    }
    return json(options.target.resume(vault), 200);
  });

  for (const path of ['/kill', '/resume']) {
    app.get(path, () => json({ error: 'method not allowed: POST with Authorization: Bearer <MM_KILL_TOKEN>' }, 405));
  }
}
