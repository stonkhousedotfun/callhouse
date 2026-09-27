/**
 * /house/<ticker>?vault=<address> opens one exact House vault of the market. The page reads the parameter, drops
 * anything that is not an address, and hands the rest to HouseVault. It never 404s or crashes on a bad value (the market's
 * default vault is shown instead), and `searchParams` may be absent: stale-market-routes.test.ts renders it with `params`
 * alone.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HouseVault } from "@/components/v2/HouseVault";
import { v2Markets } from "@/lib/markets";
import * as page from "./page";

/** The HouseVault element inside what the page returned, or undefined. The page is not rendered, only walked. */
function houseVaultIn(node: ReactNode): ReactElement<{ ticker: string; vault?: string }> | undefined {
  if (!isValidElement(node)) return undefined;
  if (node.type === HouseVault) return node as ReactElement<{ ticker: string; vault?: string }>;
  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = houseVaultIn(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

const lower = `0x${"d4".repeat(20)}`;
const checksummed = getAddress(lower);
const ticker = v2Markets()[0]!.ticker;

async function vaultProp(search?: Record<string, string | string[] | undefined>) {
  const params = Promise.resolve({ ticker: ticker.toLowerCase() });
  const element = await page.default(search === undefined ? { params } : { params, searchParams: Promise.resolve(search) });
  const house = houseVaultIn(element);
  expect(house, "the page renders HouseVault for a launch market").toBeDefined();
  expect(house!.props.ticker).toBe(ticker);
  return house!.props.vault;
}

describe("/house/[ticker]?vault=", () => {
  const before = process.env.NEXT_PUBLIC_V2;
  beforeAll(() => { process.env.NEXT_PUBLIC_V2 = "1"; });
  afterAll(() => { process.env.NEXT_PUBLIC_V2 = before; });

  it("passes a checksummed or lowercase vault through unchanged", async () => {
    expect(checksummed).not.toBe(lower);
    expect(await vaultProp({ vault: checksummed })).toBe(checksummed);
    expect(await vaultProp({ vault: lower })).toBe(lower);
  });

  it("a malformed, wrong-checksum or repeated vault renders the default vault (no prop), with no crash and no 404", async () => {
    const at = [...checksummed].findIndex((ch, i) => i > 1 && /[a-f]/i.test(ch));
    const ch = checksummed[at]!;
    const wrong = checksummed.slice(0, at) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + checksummed.slice(at + 1);
    for (const vault of ["nope", "", wrong, [lower, lower]]) {
      expect(await vaultProp({ vault }), JSON.stringify(vault)).toBeUndefined();
    }
  });

  it("no search parameters at all, or no vault among them, renders the default vault", async () => {
    expect(await vaultProp()).toBeUndefined();
    expect(await vaultProp({})).toBeUndefined();
    expect(await vaultProp({ address: lower })).toBeUndefined();
  });
});
