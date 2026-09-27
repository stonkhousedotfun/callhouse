import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn((options: unknown) => options) }));
vi.mock("./chainReads", () => ({
  readHouseVault: vi.fn(async () => "house"),
  readEarnVault: vi.fn(async () => "earn"),
  readSplitter: vi.fn(async () => "splitter"),
}));

import { v2Api } from "./api";
import { readEarnVault, readHouseVault, readSplitter } from "./chainReads";
import { useEarnVaultReads, useHouseMarket, useHouseVaultReads, useSplitterReads, v2Keys } from "./hooks";

type Options = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown>; enabled: boolean };
const lastOptions = () => vi.mocked(useQuery).mock.calls.at(-1)![0] as unknown as Options;

const vault = "0x0000000000000000000000000000000000000066" as const;
const account = "0x00000000000000000000000000000000000000Ab" as const;

beforeEach(() => vi.mocked(useQuery).mockClear());

/** The vault-page chain reads. The key is case-normalised so a checksummed and a lowercase address share a cache entry. */
describe("vault read hooks", () => {
  it("House: keyed by kind, vault and account; disabled without a vault; reads the given vault and account", async () => {
    useHouseVaultReads(vault, account);
    const o = lastOptions();
    expect(o.queryKey).toEqual(["v2", "vaultReads", "house", vault, account.toLowerCase()]);
    expect(o.enabled).toBe(true);
    await o.queryFn();
    expect(readHouseVault).toHaveBeenCalledWith(vault, account);
    useHouseVaultReads(undefined);
    expect(lastOptions().enabled).toBe(false);
  });

  it("Earn: separate key space from House for the same address", async () => {
    useEarnVaultReads(vault);
    const o = lastOptions();
    expect(o.queryKey).toEqual(v2Keys.vaultReads("earn", vault, undefined));
    expect(o.queryKey).not.toEqual(v2Keys.vaultReads("house", vault, undefined));
    await o.queryFn();
    expect(readEarnVault).toHaveBeenCalledWith(vault, undefined);
  });

  it("Splitter: disabled on a null splitter (the vault read failed), enabled otherwise", async () => {
    useSplitterReads(null);
    expect(lastOptions().enabled).toBe(false);
    useSplitterReads(vault);
    await lastOptions().queryFn();
    expect(readSplitter).toHaveBeenCalledWith(vault);
  });
});

/** The House market read carries the vault the page asked for, in its key and in its request. */
describe("useHouseMarket", () => {
  it("keys by vault (lowercased) and asks the API for that vault", async () => {
    const read = vi.spyOn(v2Api, "getHouseMarket").mockResolvedValue({} as Awaited<ReturnType<typeof v2Api.getHouseMarket>>);
    // useV2Query's queryFn reads `{ signal }` from React Query's context.
    const run = (options: Options) => (options.queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>)(
      { signal: new AbortController().signal });
    try {
      const picked = "0x00000000000000000000000000000000000000Cd";
      useHouseMarket("NVDA", account, picked);
      const o = lastOptions();
      expect(o.queryKey).toEqual(v2Keys.houseMarket("NVDA", account, picked));
      expect(o.queryKey).toEqual(["v2", "houseMarket", "NVDA", account.toLowerCase(), picked.toLowerCase()]);
      await run(o);
      expect(read).toHaveBeenCalledWith("NVDA", { address: account, vault: picked }, expect.anything());

      useHouseMarket("NVDA", account);
      expect(lastOptions().queryKey).not.toEqual(o.queryKey);
      await run(lastOptions());
      expect(read).toHaveBeenLastCalledWith("NVDA", { address: account, vault: undefined }, expect.anything());
    } finally {
      read.mockRestore();
    }
  });
});
