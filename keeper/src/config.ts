/**
 * Boot-time configuration.
 *
 * Every value the keeper needs comes from the environment and is validated here, once, before
 * anything else runs. The reason this file is strict to the point of rudeness: a keeper that
 * starts with a malformed address and only discovers it on Friday night at the write deadline
 * has already lost the week. A keeper that refuses to start gets noticed in seconds.
 *
 * Keys mirror keeper/.env.example. Anything with a sane, chain-wide constant answer has a default;
 * anything deployment-specific (vault, registry, key) does not and must be supplied.
 */
import { config as loadDotenv } from 'dotenv';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

loadDotenv({ path: process.env.KEEPER_ENV_FILE, quiet: true });

/*//////////////////////////////////////////////////////////////
                          FIELD TYPES
//////////////////////////////////////////////////////////////*/

/** An EIP-55 checksummed address. Overcall's zod schema calls `getAddress` on every address it
 *  receives, so we normalise on the way in and never have to think about casing again. */
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

const httpUrlField = z.string().transform((raw, ctx): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a URL: ${raw}` });
    return z.NEVER;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an http(s) URL: ${raw}` });
    return z.NEVER;
  }
  return parsed.toString().replace(/\/$/, '');
});

const intField = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

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

/*//////////////////////////////////////////////////////////////
                            SCHEMA
//////////////////////////////////////////////////////////////*/

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
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
  CLEARINGHOUSE: addressField.default('0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0'),
  SEAPORT: addressField.default('0x0000000000000068F116a894984e2DB1123eB395'),
  USDG: addressField.default('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  ASSET: addressField.default('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'),

  /** Per-market Overcall registry. NVDA is 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA.
   *  NOT the top-level `registry` key in Overcall's frontend config (0x65dD4079...), which is
   *  the JUGGERNAUT market. There is no default here on purpose: picking the wrong one writes
   *  calls against the wrong book. */
  REGISTRY: addressField,
  SEAPORT_CONDUIT_KEY: bytes32Field.default(ZERO_BYTES32),
  SEAPORT_ZONE: addressField.default(ZERO_ADDRESS),
  /** Receives consideration[1], Overcall's 5%. Wrong value => the order is valid Seaport but
   *  Overcall will not surface it, and the vault's on-chain check rejects it first. */
  OVERCALL_FEE_RECIPIENT: addressField.default('0xdAe7e82A2E7D566C67E87C164B05a1C560190782'),

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
  /** A listing that is not visible in Overcall's book this long after a 201 is an alert:
   *  an invisible listing is an unfilled week. */
  KEEPER_LISTING_VISIBLE_MS: intField(60_000, 86_400_000).default(900_000),
  /** How often to ask Overcall's API about the live listing. Seaport's own getOrderStatus is
   *  polled every tick because it is a single eth_call; the HTTP book is polled hourly. */
  KEEPER_FILL_POLL_MS: intField(60_000, 86_400_000).default(3_600_000),
  /** Relists allowed after a cancel/invalid. The vault caps total listings per cycle at 3
   *  regardless; this is the keeper's own, tighter budget. */
  KEEPER_MAX_RELISTS: intField(0, 2).default(1),
  /** Repeat suppression window per alert kind. */
  KEEPER_ALERT_COOLDOWN_MS: intField(0, 86_400_000).default(3_600_000),
  /** Optional manual override for the per-contract ask, in USDG base units. Set this only to
   *  override the policy/last-fill price for one cycle; leave unset in normal operation. */
  KEEPER_UNIT_PRICE_USDG6: bigintField.optional(),
  /** Basis points added on top of the policy premium floor when the keeper prices a listing:
   *  unit = ceil(floor * (10000 + margin) / 10000). The vault re-reads spot at approveListing,
   *  so a listing priced exactly at the floor reverts PremiumBelowMinimum on one upward oracle
   *  tick between the keeper's read and the vault's. A margin absorbs a spot move of up to
   *  margin/100 percent, at the cost of a slightly higher ask. 0 (default) prices at the floor
   *  exactly, as before. Capped at 1000 (10%). Not applied to KEEPER_UNIT_PRICE_USDG6. */
  PREMIUM_MARGIN_BPS: intField(0, 1000).default(0),
  /** Directory to mirror signed order payloads into, for the self-hosted fallback buy page.
   *  The payload is always kept in SQLite and served from /orders; this is belt and braces. */
  KEEPER_FALLBACK_DIR: z.string().min(1).optional(),
  /** Seconds a transaction receipt is waited for before the tick gives up and alerts. */
  KEEPER_TX_TIMEOUT_MS: intField(10_000, 600_000).default(180_000),

  /* ---- Overcall listings API ---- */
  OVERCALL_ORDERS_URL: httpUrlField.default('https://overcall.finance/api/orders'),
  /** The market query parameter. Overcall derives optionId and maker server-side, but the
   *  client always sends ?market=<symbol> and we do the same rather than rely on a default. */
  OVERCALL_MARKET: z.string().min(1).default('NVDA'),
  /** There is NO auth on Overcall's API (recon R3 section 7: no key, no bearer, no cookie).
   *  The key exists in .env.example only so the field is there if they ever add one; when set
   *  it is sent as `authorization: Bearer <key>`. */
  OVERCALL_API_KEY: z.string().min(1).optional(),
  OVERCALL_MAX_ATTEMPTS: intField(1, 10).default(5),

  /* ---- alerting ---- */
  /** Generic JSON webhook. Unset means alerts are still logged at their own severity and
   *  stored in SQLite — just not delivered anywhere. */
  ALERT_WEBHOOK: httpUrlField.optional(),

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
  // `REGISTRY=` and friends blank, so without this every blank line becomes a confusing
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

/** Convenience: the option lot. Overcall's lot size is 1e18 on every market, but the value the
 *  keeper actually writes against is always read from `registry.cycle().lotSize`. */
export const ONE_LOT = 1_000_000_000_000_000_000n;

/** USDG base units in one USDG. */
export const USDG_ONE = 1_000_000n;

/** Basis points denominator, matching contracts/src/Policy.sol. */
export const BPS = 10_000n;
