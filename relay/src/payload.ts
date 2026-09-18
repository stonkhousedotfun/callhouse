/**
 * The keeper's alert payload, as keeper/src/alerts.ts builds it and ops/alerts.md documents it:
 *
 *   { source, kind, severity, message, market, factory, vault, chainId, at, data }
 *
 * WHAT IS STRICT, and why: `severity` is the routing key (ops/alerts.md "Routing") and `kind` and
 * `message` are what a human reads, so all three are required and typed. A body without them is
 * not a keeper alert, and the relay answers 400 rather than forwarding noise into the channel.
 *
 * WHAT IS DELIBERATELY LOOSE, and why:
 *   - `kind` is any lowercase snake_case identifier, not the enum of today's thirteen kinds. The
 *     keeper and this relay deploy separately; a keeper that learns a fourteenth kind must not
 *     have every alert of it refused here. A refused alert is retried every five minutes and
 *     never arrives.
 *   - `message` has no length cap. A long message is truncated when it is formatted (format.ts),
 *     never rejected — rejecting it would lose the alert for the same reason. The body size cap
 *     in server.ts is what bounds memory.
 *   - `data` is any JSON object. The keeper serialises bigints to strings on the way out
 *     (bigintReplacer), so nothing here needs to know its shape.
 *   - `source`, `market`, `factory`, `vault`, `chainId`, `at` are optional: shown when present,
 *     not required. The v1 factory keeper sends market and factory without a vault.
 *   - Unknown top-level keys are stripped, not refused.
 */
import { z } from 'zod';

export const SEVERITIES = ['info', 'warn', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const keeperAlertSchema = z.object({
  source: z.string().max(128).optional(),
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'kind must be a lowercase snake_case identifier (≤ 64 chars)'),
  severity: z.enum(SEVERITIES),
  message: z.string().min(1, 'message must not be empty'),
  market: z.string().max(128).optional(),
  factory: z.string().max(128).optional(),
  // The v1 factory keeper sends `vault: null` when it runs without a pooled vault; accept it as absent.
  vault: z.string().max(128).nullable().optional(),
  chainId: z.number().int().nonnegative().optional(),
  at: z.string().max(64).optional(),
  data: z.record(z.unknown()).optional(),
});

export type KeeperAlert = z.infer<typeof keeperAlertSchema>;

export type ParseResult =
  | { ok: true; alert: KeeperAlert }
  | { ok: false; issues: { path: string; message: string }[] };

/** Validate an already-JSON-parsed body. Never throws. */
export function parseKeeperAlert(body: unknown): ParseResult {
  const result = keeperAlertSchema.safeParse(body);
  if (result.success) return { ok: true, alert: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}
