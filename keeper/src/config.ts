/**
 * Boot-time configuration.
 *
 * Every value the keeper needs comes from the environment and is validated here, once, before
 * anything else runs. The reason this file is strict to the point of rudeness: a keeper that
 * starts with a malformed address and only discovers it on Friday night at the write deadline
 * has already lost the week. A keeper that refuses to start gets noticed in seconds.
 *
 * Keys mirror keeper/.env.example. Anything with a sane, chain-wide constant answer has a default;
 * anything deployment-specific (vault, key) does not and must be supplied.
 *
 * There is no registry and no Overcall API under write on fill: the vault reads the option
 * tuple from the clearinghouse, the keeper creates that tuple itself, and the only venue is the
 * keeper's own /orders plus any Seaport client. Nothing here points at overcall.finance.
 */
import { config as loadDotenv } from 'dotenv';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { parseHolidays, VAULT_MIN_LEAD_SECONDS } from './calendar.js';
import { CBOE_NVDA_URL, CBOE_ROOT } from './vol.js';

loadDotenv({ path: process.env.KEEPER_ENV_FILE, quiet: true });

/*//////////////////////////////////////////////////////////////
                          FIELD TYPES
//////////////////////////////////////////////////////////////*/

/** An EIP-55 checksummed address, normalised on the way in so casing never matters again. */
const addressField = z.string().transform((raw, ctx): Address => {
  if (!isAddress(raw, { strict: false })) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a 20-byte hex address: ${raw}` });
    return z.NEVER;
  }
  return getAddress(raw);
});

const bytes32Field = z.string().transform((raw, ctx): Hex => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a 32-byte hex value: ${raw}` });
    return z.NEVER;
  }
  return raw.toLowerCase() as Hex;
});

const privateKeyField = z.string().transform((raw, ctx): Hex => {
  const withPrefix = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    // Deliberately does not echo the value.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a 32-byte hex private key' });
    return z.NEVER;
  }
  return withPrefix.toLowerCase() as Hex;
});

/** URL fields carry secrets in practice: an RPC key in the path or query, the relay token in
 *  ALERT_WEBHOOK's query string. A validation error is printed at boot, so it names what is wrong
 *  without echoing the value. */
const httpUrlField = z.string().transform((raw, ctx): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a URL (value not shown; ${raw.length} chars)` });
    return z.NEVER;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an http(s) URL (scheme ${parsed.protocol})` });
    return z.NEVER;
  }
  return parsed.toString().replace(/\/$/, '');
});

/** The market-data URL: https only (vol.ts refuses anything else at fetch time too), and, like
 *  the other URL fields, never echoed in an error. */
const httpsUrlField = z.string().transform((raw, ctx): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a URL (value not shown; ${raw.length} chars)` });
    return z.NEVER;
  }
  if (parsed.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an https URL (scheme ${parsed.protocol})` });
    return z.NEVER;
  }
  return parsed.toString();
});

const intField = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const bigintField = z.string().transform((raw, ctx): bigint => {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an integer: ${raw}` });
    return z.NEVER;
  }
  // BigInt('-1') parses fine and would silently disable whatever the field guards
  // (KEEPER_MIN_GAS_WEI=-1 switches the low-gas alert off). Fail loud like the rest.
  if (value < 0n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must not be negative: ${raw}` });
    return z.NEVER;
  }
  return value;
});

/** "YYYY-MM-DD,YYYY-MM-DD" -> the holiday table; empty means the built-in 2026–2027 one. */
const holidaysField = z.string().transform((raw, ctx): readonly string[] => {
  try {
    return parseHolidays(raw);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

/*//////////////////////////////////////////////////////////////
                            SCHEMA
//////////////////////////////////////////////////////////////*/

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const schema = z.object({
  /* ---- chain ---- */
  /** Primary RPC. Must be an archive node: it is the only endpoint used for eth_getLogs. */
  RH_RPC: httpUrlField,
  /** Backup RPC for eth_call / eth_sendRawTransaction only. publicnode REJECTS archive
   *  eth_getLogs with "Archive requests require a personal token", so clients.ts keeps a
   *  separate single-transport client for logs. */
  RH_RPC_2: httpUrlField.optional(),
  CHAIN_ID: intField(1, 2 ** 31).default(4663),
  MULTICALL3: addressField.default('0xcA11bde05977b3631167028862bE2a173976CA11'),

  /* ---- protocol addresses (chain 4663, eth_getCode-confirmed, see ops/recon) ---- */
  /** The clearinghouse the vault was CONSTRUCTED with. Overcall's Valorem instance by default;
   *  a vault deployed against our own (contracts/script/DeployClear.s.sol) needs that address.
   *  Cross-checked against `vault.clear()` at boot either way. */
  CLEARINGHOUSE: addressField.default('0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0'),
  SEAPORT: addressField.default('0x0000000000000068F116a894984e2DB1123eB395'),
  USDG: addressField.default('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  ASSET: addressField.default('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'),
  /** Zero: Seaport pulls the ERC-1155 itself. Must equal `vault.conduitKey()`. */
  SEAPORT_CONDUIT_KEY: bytes32Field.default(ZERO_BYTES32),

  /* ---- our deployment ---- */
  VAULT: addressField,

  /* ---- keeper ---- */
  KEEPER_PK: privateKeyField,
  KEEPER_DB_PATH: z.string().min(1).default('./keeper.db'),
  KEEPER_PORT: intField(1, 65535).default(8787),
  KEEPER_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Alert when the keeper's gas balance drops below this. 0.01 ETH by default. */
  KEEPER_MIN_GAS_WEI: bigintField.default('10000000000000000'),
  /** Alert when the head block's timestamp trails the wall clock by more than this. */
  KEEPER_RPC_LAG_ALERT_MS: intField(10_000, 86_400_000).default(300_000),
  /** Repeat suppression window per alert kind. */
  KEEPER_ALERT_COOLDOWN_MS: intField(0, 86_400_000).default(3_600_000),
  /** Seconds a transaction receipt is waited for before the tick gives up and alerts. */
  KEEPER_TX_TIMEOUT_MS: intField(10_000, 600_000).default(180_000),

  /* ---- the week ---- */
  /** fixed mode only (KEEPER_PRICING_MODE=fixed): how far above spot the strike sits, in basis
   *  points, before rounding to a whole USDG. Default 500 (5%). Must land inside the vault's
   *  policy band (launch: 3%–12%) at the spot of the arm; a target outside it is refused before
   *  any gas is spent. */
  KEEPER_STRIKE_OTM_BPS: intField(0, 5_000).default(500),
  /** The keeper's own minimum distance to the Friday close when it arms, in seconds. At least
   *  the vault's MIN_LEAD (3600); the default is six hours, because arming an hour before the
   *  close sells one hour of calls against a week of collateral lock. Too close means the
   *  following Friday. */
  KEEPER_ARM_LEAD_S: intField(VAULT_MIN_LEAD_SECONDS, 6 * 86_400).default(6 * 3_600),
  /** Full-day NYSE closures as YYYY-MM-DD, comma-separated. Unset: the built-in 2026–2027 table
   *  (calendar.ts). Set it once that table runs out, or when the exchange adds a closure. */
  KEEPER_NYSE_HOLIDAYS: holidaysField.default(''),

  /* ---- pricing ---- */
  /** Optional manual override for the per-contract ask, in USDG base units. For one unusual
   *  cycle; leave unset in normal operation. Still floored at the live fill floor and capped at
   *  the strike, because the vault enforces both. In vol mode it can only RAISE the ask: the
   *  listing is never below max(fill floor with the margin, fair value with the edge), and never
   *  armed or listed without market data. To sell below the market, use KEEPER_PRICING_MODE=fixed. */
  KEEPER_UNIT_PRICE_USDG6: bigintField.optional(),
  /** Basis points added to the vault's FILL-TIME premium floor when the keeper prices a listing:
   *  unit = ceil(floor × (10000 + margin) / 10000). The fill gate re-derives the floor from the
   *  spot of the FILL, not of the listing (PremiumBelowFloorAtFill), so a listing priced exactly
   *  at today's floor is refused by the first buyer after any uptick. A margin of m bps absorbs
   *  a spot rise of up to m bps before the keeper has to reprice (each reprice spends one of the
   *  vault's three listings a week). Trade-off: higher margin, fewer reprices, slightly higher
   *  ask. Default 100 (1%). Capped at 1000. Not applied to KEEPER_UNIT_PRICE_USDG6. In vol mode
   *  this is the floor under the market price, not the price. */
  KEEPER_PREMIUM_MARGIN_BPS: intField(0, 1_000).default(100),
  /** How the week's strike and ask are chosen.
   *    vol    (default) strike = the listed weekly call at KEEPER_TARGET_DELTA, from Cboe's delayed
   *           quotes, mapped to the token and clamped into the vault's band; ask = max(fill floor
   *           with KEEPER_PREMIUM_MARGIN_BPS, market fair value lifted by KEEPER_PRICE_EDGE_BPS).
   *           Missing, stale or inconsistent market data skips the week (a named `vol-*` reason);
   *           it never falls back to `fixed`.
   *    fixed  strike = spot + KEEPER_STRIKE_OTM_BPS, ask = fill floor with the margin. */
  KEEPER_PRICING_MODE: z.enum(['vol', 'fixed']).default('vol'),
  /** vol mode: the call delta the strike targets, 0.05..0.40. Default 0.15. Linear interpolation
   *  between the two listed strikes that bracket it; a target the quotes do not reach skips. */
  KEEPER_TARGET_DELTA: z.coerce.number().finite().min(0.05).max(0.4).default(0.15),
  /** vol mode: basis points over the market's fair value (interpolated listed mid) the ask sits
   *  at: vol ask = ceil(fair × (10000 + edge) / 10000). Never below the fill floor with the
   *  margin, never above the strike. Default 1000 (10%). 0..5000. */
  KEEPER_PRICE_EDGE_BPS: intField(0, 5_000).default(1_000),
  /** vol mode: the delayed option chain. https only. Default Cboe's NVDA chain. */
  KEEPER_VOL_URL: httpsUrlField.default(CBOE_NVDA_URL),
  /** vol mode: the option root the chain must report (`data.symbol`); a file for any other ticker
   *  is skipped as `vol-inconsistent`. Default NVDA. */
  KEEPER_VOL_ROOT: z.string().regex(/^[A-Z]{1,6}$/, 'an upper-case option root, e.g. NVDA').default(CBOE_ROOT),
  /** vol mode: the oldest last trade (and file) the keeper prices on, seconds. Default 345600
   *  (4 days), the vault's own maxPriceAge: a Saturday arm reads Friday's close. */
  KEEPER_VOL_MAX_AGE_S: intField(3_600, 14 * 86_400).default(345_600),
  /** vol mode: how far the vault's token spot may sit from the feed's share spot, in bps of the
   *  ratio. The token's multiplier is ~8 bps; beyond this one of the two is wrong. Default 300. */
  KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS: intField(1, 2_000).default(300),
  /** vol mode: deadline for the whole fetch (connect, headers, body), ms. Default 10000. */
  KEEPER_VOL_TIMEOUT_MS: intField(1_000, 60_000).default(10_000),
  /** vol mode: body byte cap, enforced while streaming. Default 8000000 (the NVDA chain is ~1.9 MB). */
  KEEPER_VOL_MAX_BYTES: intField(100_000, 64_000_000).default(8_000_000),
  /** vol mode: the strike is never closer to spot than the vault's band floor PLUS this many bps.
   *  A strike right on the floor goes unfillable (StrikeBelowBand at the fill) on the first uptick,
   *  and no reprice fixes a strike; the buffer is the rally the week survives. A delta-0.15 strike
   *  on a two- to four-day expiry, or in a quiet week, lands close to the floor, so the default is
   *  200: the room the fixed rule has (5% strike over a 3% floor). 0..1000. */
  KEEPER_STRIKE_BAND_BUFFER_BPS: intField(0, 1_000).default(200),
  /** vol mode: reprice a live, still-fillable listing UP when fresh market data puts the ask
   *  (fair value with the edge) more than this many bps above the live ask, so a rally does not
   *  leave the week selling at last week's price. Only while a listing slot would still be left
   *  over for a floor reprice (the vault allows three a week). Checked at most every 30 minutes.
   *  Default 2500 (the live ask is 20% or more under the market-based ask). 0 turns it off. */
  KEEPER_VOL_REPRICE_UP_BPS: intField(0, 50_000).default(2_500),
  /** Directory to mirror each authorised order payload into, for the self-hosted fill page.
   *  The payload is always kept in SQLite and served from /orders; this is belt and braces. */
  KEEPER_FALLBACK_DIR: z.string().min(1).optional(),

  /* ---- stranded claims ---- */
  /** How often `retryStrandedClaim()` is attempted while the vault is stranded. Permissionless
   *  and harmless while the freeze holds (the simulation reverts StillStranded and nothing is
   *  sent), so hourly by default; the floor is a second so a fork rehearsal can drive it. */
  KEEPER_RETRY_STRANDED_MS: intField(1_000, 86_400_000).default(3_600_000),

  /* ---- alerting ---- */
  /** Generic JSON webhook. Unset means alerts are still logged at their own severity and
   *  stored in SQLite — just not delivered anywhere. */
  ALERT_WEBHOOK: httpUrlField.optional(),
  /** Sent as `authorization: Bearer <token>` with every webhook POST when set. The relay
   *  (relay/) requires it; prefer this over `?token=` in ALERT_WEBHOOK, which proxies can log. */
  ALERT_WEBHOOK_TOKEN: z.string().min(16).optional(),

  /* ---- loop ---- */
  POLL_INTERVAL_MS: intField(5_000, 3_600_000).default(60_000),
});

export type KeeperConfig = z.infer<typeof schema>;

/*//////////////////////////////////////////////////////////////
                            LOADING
//////////////////////////////////////////////////////////////*/

/** Parse process.env. Throws with every problem listed, not just the first. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  // Empty strings in a .env file are "unset", not "the empty value". `.env.example` ships with
  // `VAULT=` and friends blank, so without this every blank line becomes a confusing
  // "expected string, received string" instead of "Required".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value.trim();
  }

  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  ${key}: ${issue.message}`;
    });
    throw new Error(
      `Keeper configuration is not usable. Fix these and restart:\n${lines.join('\n')}\n\n` +
        'Every key is documented in keeper/README.md and keeper/.env.example (the repo-root ' +
        '.env.example covers the other services and lacks most keeper keys).',
    );
  }
  return parsed.data;
}

/** The process-wide config. Importing this module is what makes a bad environment fatal.
 *
 *  It exits rather than throws, because this runs during module evaluation — before the logger
 *  exists and before anything can catch it — and an operator reading a crash at 20:00 UTC on a
 *  Friday deserves the list of broken keys, not a stack trace through the ESM loader. */
function loadOrDie(): KeeperConfig {
  try {
    return loadConfig();
  } catch (error) {
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exit(1);
  }
}

export const config: KeeperConfig = loadOrDie();

/** One lot: exactly one Stock Token. `Policy.LOT`; the only `underlyingAmount` the vault arms. */
export const ONE_LOT = 1_000_000_000_000_000_000n;

/** USDG base units in one USDG. */
export const USDG_ONE = 1_000_000n;

/** Basis points denominator, matching contracts/src/Policy.sol. */
export const BPS = 10_000n;
