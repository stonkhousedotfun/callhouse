import { getV2Market, type V2Market } from "@/lib/markets";
import { longIdOf } from "@/lib/v2/seriesId";

const UINT = /^(0|[1-9]\d*)$/;
const ALIAS = /^([cp])-([1-9]\d*(?:\.\d{1,6})?)-(\d{4}-\d{2}-\d{2})$/;

/** A canonical lowercase ticker in the compiled registry, including not-yet-live v2 markets. */
export function parseV2Ticker(param: string): V2Market | undefined {
  if (!/^[a-z0-9.]{1,10}$/.test(param)) return undefined;
  return getV2Market(param);
}

/** Numeric long id or a readable call/put alias. Returns the canonical decimal id. */
export function parseV2Series(ticker: V2Market, param: string): string | undefined {
  if (UINT.test(param)) {
    try {
      const id = BigInt(param);
      return id > 0n && id % 2n === 0n && id < 2n ** 256n ? param : undefined;
    } catch {
      return undefined;
    }
  }
  const match = ALIAS.exec(param);
  if (!match) return undefined;
  const [, side, dollars, date] = match;
  if (!side || !dollars || !date) return undefined;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const at20 = Date.UTC(year, month - 1, day, 20);
  if (new Date(at20).toISOString().slice(0, 10) !== date) return undefined;
  // Every option expires at 16:00 New York. 20:00 UTC in EDT, 21:00 UTC in EST.
  const nyHourAt20 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(new Date(at20));
  const expiry = (at20 + (nyHourAt20 === "16" ? 0 : 3_600_000)) / 1000;
  const [whole, fraction = ""] = dollars.split(".");
  const strike = BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  try {
    return longIdOf(ticker.asset, side === "p", strike, expiry).toString();
  } catch {
    return undefined;
  }
}
