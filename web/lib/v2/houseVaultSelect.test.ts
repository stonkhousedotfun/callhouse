import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import type { HouseVault } from "./api-types";
import { houseWindDownHeadline } from "./houseWindDown";
import {
  HOUSE_SIBLING_CLOSED, HOUSE_VAULT_MISMATCH, houseSiblings, houseSiblingsHeading, houseVaultHref, houseVaultMismatch,
  houseVaultUnavailable, parseVaultParam,
} from "./houseVaultSelect";

const lower = `0x${"d4".repeat(20)}`;
const checksummed = getAddress(lower);

/** One letter's case flipped: still mixed case, so viem's strict check reads it as a wrong checksum. */
function wrongChecksum(address: string): string {
  const at = [...address].findIndex((ch, i) => i > 1 && /[a-f]/i.test(ch));
  const ch = address[at]!;
  return address.slice(0, at) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + address.slice(at + 1);
}

const item = (market: string, vault: string | null, kind: HouseVault["kind"] = "weekly"): HouseVault =>
  ({ market, vault, kind, currentEpoch: null, sharesSupply: null });

describe("parseVaultParam", () => {
  it("accepts the lowercase and the checksummed form, unchanged", () => {
    expect(checksummed).not.toBe(lower);
    expect(parseVaultParam(lower)).toBe(lower);
    expect(parseVaultParam(checksummed)).toBe(checksummed);
  });

  it("ignores a wrong checksum, a non-address, an empty value, a repeated parameter and an absent one", () => {
    const bad = wrongChecksum(checksummed);
    expect(bad.toLowerCase()).toBe(lower);
    expect(parseVaultParam(bad)).toBeUndefined();
    expect(parseVaultParam("nope")).toBeUndefined();
    expect(parseVaultParam("")).toBeUndefined();
    expect(parseVaultParam([lower, lower])).toBeUndefined();
    expect(parseVaultParam(undefined)).toBeUndefined();
  });
});

describe("houseVaultMismatch", () => {
  it("is true only when a vault was asked for and a different one was served, ignoring case", () => {
    expect(houseVaultMismatch(checksummed, `0x${"c3".repeat(20)}`)).toBe(true);
    expect(houseVaultMismatch(checksummed, lower)).toBe(false);
    expect(houseVaultMismatch(lower, checksummed)).toBe(false);
  });

  it("nothing asked for, or nothing served yet, is not a mismatch", () => {
    expect(houseVaultMismatch(undefined, lower)).toBe(false);
    expect(houseVaultMismatch(checksummed, null)).toBe(false);
    expect(houseVaultMismatch(checksummed, undefined)).toBe(false);
  });
});

describe("houseSiblings", () => {
  const weekly = getAddress(`0x${"c3".repeat(20)}`);
  const list = [item("NVDA", checksummed, "daily"), item("nvda", weekly, "weekly"), item("SPCX", `0x${"e5".repeat(20)}`),
    item("NVDA", null)];

  it("keeps this market's other vaults (market ignoring case), drops the one shown and any without an address", () => {
    expect(houseSiblings(list, "NVDA", lower).map((row) => row.vault)).toEqual([weekly]);
    expect(houseSiblings(list, "nvda", weekly.toLowerCase()).map((row) => row.vault)).toEqual([checksummed]);
  });

  it("with nothing shown yet, lists every vault of the market in list order", () => {
    expect(houseSiblings(list, "NVDA", null).map((row) => row.vault)).toEqual([checksummed, weekly]);
  });
});

describe("links and copy", () => {
  it("links one exact vault of a market", () => {
    expect(houseVaultHref("NVDA", checksummed)).toBe(`/house/nvda?vault=${checksummed}`);
  });

  it("the sibling marker never says winding down, in any case, so a daily page linking a closing weekly vault does not read as closing", () => {
    expect(HOUSE_SIBLING_CLOSED.toLowerCase()).not.toContain("winding down");
    expect(houseWindDownHeadline(null)).toContain("Winding down");
    expect(HOUSE_SIBLING_CLOSED).not.toBe(houseWindDownHeadline(null));
  });

  it("names the market in the heading and the unavailable line", () => {
    expect(houseSiblingsHeading("NVDA")).toContain("NVDA");
    expect(houseVaultUnavailable("NVDA")).toContain("NVDA");
    expect(HOUSE_VAULT_MISMATCH.length).toBeGreaterThan(0);
  });
});
