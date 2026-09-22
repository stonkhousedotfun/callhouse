/**
 * Launch gates: what is not open yet, and when the chain says it will be.
 *
 * Two facts per gate, both read on chain and never inferred from each other:
 *   - `done`        the effect itself (market enabled / vault armed)
 *   - `scheduledAt` the AccessManager schedule for the Safe operation that produces it (0 = none pending)
 *
 * The phase is derived from those two and the clock, so a page never shows "opens in 3 min" for a gate the
 * Safe already executed, nor "open" for one it only scheduled. Registration and the app's release status stay
 * where they are (marketAccess.ts); this module answers only "why is this control faded, and until when".
 */
import { getAddress, type Address, type PublicClient } from "viem";

import { accessManagerAbi } from "../abi/v2/accessManager";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { houseVaultAbi } from "../abi/v2/houseVault";
import { publicClient } from "../chain";
import { GENERATED_MARKETS, LAUNCH_SET } from "../markets.generated";
import { requireV2Address } from "./config";
import { LAUNCH_ARM_OPS, LAUNCH_GOLIVE_OPS } from "./launchSchedule";

export type LaunchGatePhase =
  | "done"        // the effect is on chain
  | "counting"    // scheduled, not yet executable
  | "due"         // executable now, waiting for the Safe to send the execute
  | "unscheduled"; // nothing pending and the effect is absent

export type LaunchGate = {
  done: boolean;
  /** Unix seconds the scheduled operation becomes executable; 0 when nothing is scheduled. */
  scheduledAt: number;
};

export type LaunchGates = {
  /** Trading on each launch market: `Clearinghouse.market(asset).enabled`. */
  trading: Readonly<Record<string, LaunchGate>>;
  /** Each launch market's House vault quoting: `HouseVault.protocolAccountsConfirmed()`. */
  house: Readonly<Record<string, LaunchGate>>;
};

export function launchGatePhase(gate: LaunchGate, nowSeconds: number): LaunchGatePhase {
  if (gate.done) return "done";
  if (gate.scheduledAt === 0) return "unscheduled";
  return gate.scheduledAt > nowSeconds ? "counting" : "due";
}

/** "1d 02:03:04" / "02:03:04"; never negative. */
export function countdownLabel(secondsRemaining: number): string {
  const s = Math.max(0, Math.floor(secondsRemaining));
  const days = Math.floor(s / 86_400);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(Math.floor((s % 86_400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

function launchMarkets() {
  return LAUNCH_SET.markets.map((ticker) => {
    const row = GENERATED_MARKETS.find((m) => m.ticker === ticker);
    if (!row) throw new Error(`launch market ${ticker} is not in the generated registry`);
    return { ticker, asset: getAddress(row.asset), houseVault: row.v2.houseVault ? getAddress(row.v2.houseVault) : null };
  });
}

async function schedule(client: PublicClient, manager: Address, opId: `0x${string}`): Promise<number> {
  const when = await client.readContract({ address: manager, abi: accessManagerAbi, functionName: "getSchedule", args: [opId] });
  return Number(when);
}

export async function readLaunchGates(client: PublicClient = publicClient): Promise<LaunchGates> {
  const manager = requireV2Address("accessManager");
  const clearinghouse = requireV2Address("clearinghouse");
  const trading: Record<string, LaunchGate> = {};
  const house: Record<string, LaunchGate> = {};
  await Promise.all(launchMarkets().map(async (market) => {
    const [config, goliveAt] = await Promise.all([
      client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [market.asset] }),
      LAUNCH_GOLIVE_OPS[market.ticker] ? schedule(client, manager, LAUNCH_GOLIVE_OPS[market.ticker]) : Promise.resolve(0),
    ]);
    trading[market.ticker] = { done: config.enabled, scheduledAt: goliveAt };
    if (!market.houseVault) return;
    const [armed, ...armAts] = await Promise.all([
      client.readContract({ address: market.houseVault, abi: houseVaultAbi, functionName: "protocolAccountsConfirmed" }),
      ...(LAUNCH_ARM_OPS[market.ticker] ?? []).map((op) => schedule(client, manager, op)),
    ]);
    // the FIRST `blocked = true` execute arms the vault, so the earliest pending schedule is the one that counts
    const pending = armAts.filter((at) => at > 0);
    house[market.ticker] = { done: armed, scheduledAt: pending.length ? Math.min(...pending) : 0 };
  }));
  return { trading, house };
}
