import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { desc, eq, gte, sql } from "ponder";

import { USDG, V2_FEE_SPLITTER, V2_FLYWHEEL_TOKEN_ADDRESS } from "../../../lib/env";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { indexedHead } from "./machine";
import { address } from "./shared";

const WEEK = 7n * 86_400n;

type RegistrySupplement = {
  token?: { decimals?: number | null };
  shared?: { token?: { decimals?: number | null } };
};

const registrySupplement = V2_REGISTRY as unknown as RegistrySupplement;
const tokenDecimals = registrySupplement.token?.decimals ?? registrySupplement.shared?.token?.decimals ?? 18;
const marketAssets = new Map(V2_REGISTRY.markets.map((market) => [market.underlying.toLowerCase(), {
  symbol: market.ticker,
  decimals: 18,
}]));

function assetMeta(asset: string) {
  if (asset.toLowerCase() === USDG.toLowerCase()) return { symbol: "USDG", decimals: 6 };
  return marketAssets.get(asset.toLowerCase()) ?? { symbol: null, decimals: null };
}

function distributionWire(row: typeof schema.v2FlywheelDistribution.$inferSelect) {
  return {
    id: row.id,
    asset: address(row.asset),
    ...assetMeta(row.asset),
    assetInRaw: row.assetIn.toString(),
    usdgInRaw: row.usdgIn.toString(),
    treasuryOutRaw: row.treasuryOut.toString(),
    buybackAddedRaw: row.buybackAdded.toString(),
    ts: Number(row.ts),
    tx: row.tx,
  };
}

export function registerFlywheelRoutes(app: Hono) {
  app.get("/flywheel", async (c) => {
    if (V2_FEE_SPLITTER === undefined) {
      return c.json({
        configured: false,
        splitter: null,
        tokenAddress: null,
        tokenDecimals: null,
        burnedTotal: null,
        burned7d: null,
        revenue7d: [],
        held: [],
        lastDistribution: null,
        distributions: [],
      });
    }

    const indexedAt = (await indexedHead())?.ts ?? 0n;
    const since = indexedAt > WEEK ? indexedAt - WEEK : 0n;
    const splitter = V2_FEE_SPLITTER.toLowerCase() as `0x${string}`;
    const [burnedTotal, burned7d, nativeRevenue, distributions, swept, distributed] = await Promise.all([
      db.select({ amount: sql<string>`coalesce(sum(${schema.v2FlywheelBurn.amount}), 0)::text` })
        .from(schema.v2FlywheelBurn),
      db.select({ amount: sql<string>`coalesce(sum(${schema.v2FlywheelBurn.amount}), 0)::text` })
        .from(schema.v2FlywheelBurn).where(gte(schema.v2FlywheelBurn.ts, since)),
      db.select({
        asset: schema.v2FlywheelDistribution.asset,
        amount: sql<string>`coalesce(sum(${schema.v2FlywheelDistribution.assetIn}), 0)::text`,
      }).from(schema.v2FlywheelDistribution)
        .where(gte(schema.v2FlywheelDistribution.ts, since))
        .groupBy(schema.v2FlywheelDistribution.asset),
      db.select().from(schema.v2FlywheelDistribution)
        .orderBy(desc(schema.v2FlywheelDistribution.block), desc(schema.v2FlywheelDistribution.logIndex))
        .limit(20),
      db.select({
        asset: schema.v2FeeSweep.asset,
        amount: sql<string>`coalesce(sum(${schema.v2FeeSweep.amount}), 0)::text`,
      }).from(schema.v2FeeSweep)
        .where(eq(schema.v2FeeSweep.recipient, splitter))
        .groupBy(schema.v2FeeSweep.asset),
      db.select({
        asset: schema.v2FlywheelDistribution.asset,
        amount: sql<string>`coalesce(sum(${schema.v2FlywheelDistribution.assetIn}), 0)::text`,
      }).from(schema.v2FlywheelDistribution)
        .groupBy(schema.v2FlywheelDistribution.asset),
    ]);

    const distributedByAsset = new Map(distributed.map((row) => [row.asset.toLowerCase(), BigInt(row.amount)]));
    // This is the event-derived balance the indexer can prove: Clearinghouse sweeps into the
    // splitter minus Distributed asset inputs. Unsolicited ERC-20 transfers emit no indexed row.
    const held = swept.flatMap((row) => {
      if (row.asset.toLowerCase() === USDG.toLowerCase()) return [];
      const amount = BigInt(row.amount) - (distributedByAsset.get(row.asset.toLowerCase()) ?? 0n);
      return amount > 0n ? [{
        asset: address(row.asset),
        ...assetMeta(row.asset),
        amountRaw: amount.toString(),
      }] : [];
    }).sort((left, right) => left.asset.localeCompare(right.asset));
    const items = distributions.map(distributionWire);
    return c.json({
      configured: true,
      splitter: address(V2_FEE_SPLITTER),
      tokenAddress: V2_FLYWHEEL_TOKEN_ADDRESS === undefined ? null : address(V2_FLYWHEEL_TOKEN_ADDRESS),
      tokenDecimals,
      burnedTotal: burnedTotal[0]?.amount ?? "0",
      burned7d: burned7d[0]?.amount ?? "0",
      revenue7d: nativeRevenue.map((row) => ({
        asset: address(row.asset),
        ...assetMeta(row.asset),
        amountRaw: row.amount,
      })).sort((left, right) => left.asset.localeCompare(right.asset)),
      held,
      lastDistribution: items[0] ?? null,
      distributions: items,
    });
  });
}
