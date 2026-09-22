/**
 * FROZEN minimal copy of the v7 `/v2/accounts/:address/positions` response from
 * 9556a518111b0cbd824ae590f6946a636d8ace68:web/lib/v2/api-schema.ts.
 * Do not import the live v8 twin here: X8-03 is allowed to change it independently.
 */
import { checksumAddress } from "viem";
import { z } from "zod";

const UINT_RE = /^(0|[1-9]\d*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const countSchema = z.number().int().nonnegative();
const uintStringSchema = z.string().regex(UINT_RE, "expected a canonical decimal uint string");
const addressSchema = z.string().refine(
  (address) => ADDRESS_RE.test(address) && checksumAddress(address as `0x${string}`) === address,
  { message: "expected an EIP-55 checksummed address" },
);
const unixSchema = z.number().int().nonnegative();
const moneySchema = z.object({ raw: uintStringSchema, decimals: countSchema, formatted: z.string() }).strict();
const signedMoneySchema = z.object({
  raw: z.string().regex(/^(0|-?[1-9]\d*)$/), decimals: countSchema, formatted: z.string(),
}).strict();

const seriesStatusSchema = z.enum(["open", "cutoff", "expired", "settling", "held", "settled"]);
const seriesRefSchema = z.object({
  longId: uintStringSchema,
  shortId: uintStringSchema,
  ticker: z.string().min(1),
  underlying: addressSchema,
  isPut: z.boolean(),
  strike: moneySchema,
  expiry: unixSchema,
  tenor: z.enum(["daily", "weekly", "special"]),
  mintCutoff: unixSchema,
  mintFeePpm: countSchema.max(5_000),
  mintFeesHeld: moneySchema,
  mintFeesAccrued: moneySchema,
  status: seriesStatusSchema,
}).strict();
const orderKindSchema = z.enum(["Bid", "AskResale", "AskWrite"]);

export const v7PositionsResponseSchema = z.object({
  longs: z.array(z.object({
    series: seriesRefSchema,
    units: uintStringSchema,
    avgCost: moneySchema,
    mark: moneySchema.nullable(),
    markSource: z.enum(["fair", "best-bid"]).nullable().optional(),
    unrealised: signedMoneySchema.nullable(),
    claimable: moneySchema.nullable(),
  }).strict()),
  shorts: z.array(z.object({
    series: seriesRefSchema,
    units: uintStringSchema,
    premiumReceived: moneySchema,
    collateralLocked: moneySchema,
    claimable: moneySchema.nullable(),
  }).strict()),
  orders: z.array(z.object({
    orderId: uintStringSchema,
    series: seriesRefSchema,
    kind: orderKindSchema,
    price: moneySchema,
    units: uintStringSchema,
    filled: uintStringSchema,
    validUntil: unixSchema,
  }).strict()),
  ledger: z.array(z.object({ asset: addressSchema, symbol: z.string().min(1), free: moneySchema }).strict()),
  // Kept so the strict v7 response still parses; the run-off page never exposes strategy writes.
  strategies: z.array(z.unknown()),
  prefs: z.object({ inKind: z.boolean(), toLedger: z.boolean() }).strict(),
}).strict();

export type V7PositionsResponse = z.infer<typeof v7PositionsResponseSchema>;
