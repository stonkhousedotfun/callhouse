/**
 * PONDER_RPC_URL_4663 as a list (the dRPC backup is listed SECOND, after the primary).
 *
 * WHAT IS PINNED: a comma list becomes one entry per URL, in the order given, and reaches Ponder's
 * `chains.robinhood.rpc` as an array (one transport and one rate limit per entry, ponder.config.ts);
 * a single URL stays the plain string it always was; an empty entry refuses to start without
 * echoing the value (production URLs carry an API key). The URLs below are fakes.
 *
 * lib/env.ts reads the environment when it is imported (and throws without PONDER_RPC_URL_4663),
 * so nothing imports it statically: each case stubs the variable, resets the module registry and
 * imports it again.
 *
 * NOT COLLECTED BY `pnpm test`: vitest.config.ts includes only src/** and scripts/**. Run it by
 * path with an include that covers lib/.
 */
import { readFileSync } from "node:fs";

import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const PRIMARY = "https://primary-rpc.invalid/v2/FAKE-PRIMARY-KEY";
const BACKUP = "https://backup-rpc.invalid/rh/FAKE-BACKUP-KEY";

/**
 * env.ts refuses to load without a deployment mode ("set a vault, a factory or a clearinghouse").
 * The pooled-vault mode needs the fewest other variables; the address is a fake.
 */
const VAULT = "0x000000000000000000000000000000000000dEaD";

async function loadEnv(value: string) {
  vi.stubEnv("VAULT_ADDRESS", VAULT);
  vi.stubEnv("START_BLOCK", "61000000");
  vi.stubEnv("PONDER_RPC_URL_4663", value);
  vi.resetModules();
  return import("./env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("parseRpcUrls", () => {
  it("splits a comma list into entries in the order given, trimming spaces", async () => {
    const { parseRpcUrls } = await loadEnv(PRIMARY);
    expect(parseRpcUrls(`${PRIMARY},${BACKUP}`)).toEqual([PRIMARY, BACKUP]);
    expect(parseRpcUrls(` ${PRIMARY} , ${BACKUP} `)).toEqual([PRIMARY, BACKUP]);
  });

  it("keeps a single URL as one entry", async () => {
    const { parseRpcUrls } = await loadEnv(PRIMARY);
    expect(parseRpcUrls(PRIMARY)).toEqual([PRIMARY]);
  });

  it("refuses an empty entry and names its position, never the value", async () => {
    const { parseRpcUrls } = await loadEnv(PRIMARY);
    for (const raw of [`${PRIMARY},`, `,${BACKUP}`, `${PRIMARY},,${BACKUP}`]) {
      let message = "";
      try {
        parseRpcUrls(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/PONDER_RPC_URL_4663 has an empty entry at position \d+ of \d+/);
      expect(message).not.toContain("FAKE");
    }
  });
});

describe("RPC_URL, the value ponder.config.ts hands to chains.robinhood.rpc", () => {
  it("primary,backup: an array of two, primary first", async () => {
    const env = await loadEnv(`${PRIMARY},${BACKUP}`);
    expect(env.RPC_URLS).toEqual([PRIMARY, BACKUP]);
    expect(env.RPC_URL).toEqual([PRIMARY, BACKUP]);
  });

  it("one URL: the plain string, as before a backup existed", async () => {
    const env = await loadEnv(PRIMARY);
    expect(env.RPC_URLS).toEqual([PRIMARY]);
    expect(env.RPC_URL).toBe(PRIMARY);
  });
});

describe("ETH_GET_LOGS_BLOCK_RANGE, ponder.config.ts's chains.robinhood.ethGetLogsBlockRange", () => {
  it("the cap is a whole number of blocks the backup answers for one address", async () => {
    const env = await loadEnv(PRIMARY);
    const { RPC_MAX_GET_LOGS_ADDRESS_BLOCKS } = await import("./getLogsRange");
    expect(Number.isInteger(env.ETH_GET_LOGS_BLOCK_RANGE)).toBe(true);
    expect(env.ETH_GET_LOGS_BLOCK_RANGE).toBeGreaterThan(0);
    expect(env.ETH_GET_LOGS_BLOCK_RANGE).toBeLessThanOrEqual(RPC_MAX_GET_LOGS_ADDRESS_BLOCKS);
  });

  it("the addresses x blocks limit is the backup RPC's measured one, not a number typed here", async () => {
    const { RPC_MAX_GET_LOGS_ADDRESS_BLOCKS } = await import("./getLogsRange");
    const doc = readFileSync(new URL("../../ops/rpc/BACKUP-RPC.md", import.meta.url), "utf8");
    const measured = doc.match(/\| `eth_getLogs` block range \| \*\*at most ([\d,]+) addresses x blocks\.\*\*/)?.[1];
    expect(measured, "BACKUP-RPC.md's eth_getLogs block-range row is where this test reads it").toBeDefined();
    expect(Number(measured!.replaceAll(",", ""))).toBe(RPC_MAX_GET_LOGS_ADDRESS_BLOCKS);
  });

  it("is what ponder.config.ts hands Ponder: the cap narrowed by its sources' address count", async () => {
    for (const value of [PRIMARY, `${PRIMARY},${BACKUP}`]) {
      const env = await loadEnv(value);
      const { default: config } = await import("../ponder.config");
      const { ethGetLogsBlockRange, maxAddressesPerGetLogs } = await import("./getLogsRange");
      const range = config.chains.robinhood.ethGetLogsBlockRange!;
      expect(range).toBe(ethGetLogsBlockRange(maxAddressesPerGetLogs(config.contracts).max, env.ETH_GET_LOGS_BLOCK_RANGE));
      expect(range).toBeLessThanOrEqual(env.ETH_GET_LOGS_BLOCK_RANGE);
      expect(config.chains.robinhood.rpc).toEqual(env.RPC_URL);
    }
  });
});

/**
 * Boot validation. Every variable env.ts reads is cleared first (an empty string reads as unset), so a value leaked
 * from the shell cannot decide a case; then each case sets only what it is about.
 */
const ALL_VARS = [
  "PONDER_RPC_URL_4663", "VAULT_ADDRESS", "VAULT", "FACTORY_ADDRESS", "FACTORY", "START_BLOCK", "END_BLOCK", "MARKET",
  "V2_CLEARINGHOUSE", "V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY", "V2_START_BLOCK",
  "V2_EXPIRY_CALENDAR", "V2_KEEPER_REWARDS", "V2_ACCESS_MANAGER", "V2_PAYOUT_ROUTER", "V2_FEE_SPLITTER",
  "V2_BUYBACK_EXECUTOR", "V2_FLYWHEEL_TOKEN_ADDRESS", "V2_MAKER_VAULT", "V2_REWARDS_DISTRIBUTOR",
  "V2_REWARDS_DISTRIBUTORS", "V2_EARN_VAULT", "V2_ZAP_HELPER", "V2_HOUSE_VAULT_FACTORY", "V2_FLYWHEEL_START_BLOCK",
  "V2_EARN_START_BLOCK", "V2_HOUSE_START_BLOCK", "V2_PRODUCTION", "PRICING_URL", "CLEARINGHOUSE", "SEAPORT", "USDG",
  "ASSET", "MULTICALL3", "PGLITE_DIRECTORY", "LIVE_READ_TIMEOUT_MS",
];
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const V2_CORE = {
  V2_CLEARINGHOUSE: addr(0xc1), V2_ORDER_BOOK: addr(0xc2), V2_SETTLEMENT_ORACLE: addr(0xc3),
  V2_AUTO_ROLLER: addr(0xc4), V2_MAKER_REGISTRY: addr(0xc5), V2_START_BLOCK: "100",
};

async function boot(vars: Record<string, string>) {
  for (const name of ALL_VARS) vi.stubEnv(name, "");
  vi.stubEnv("PONDER_RPC_URL_4663", PRIMARY);
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  vi.resetModules();
  return import("./env");
}

describe("env.ts boot validation", () => {
  it("refuses to start without an RPC URL, naming the variable", async () => {
    await expect(boot({ VAULT_ADDRESS: VAULT, START_BLOCK: "1", PONDER_RPC_URL_4663: "  " }))
      .rejects.toThrow("Missing required environment variable PONDER_RPC_URL_4663");
  });

  it("refuses to start with no deployment mode at all", async () => {
    await expect(boot({})).rejects.toThrow("None is set");
  });

  it("vault mode: checksums addresses, applies the protocol defaults and exposes vaultAddress()", async () => {
    const env = await boot({ VAULT: VAULT.toLowerCase(), START_BLOCK: " 61000000 " });
    expect(env.VAULT).toBe(VAULT);
    expect(env.vaultAddress()).toBe(VAULT);
    expect(env.FACTORY).toBeUndefined();
    expect(env.V2_CLEARINGHOUSE).toBeUndefined();
    expect(env.V2_ORDER_BOOK).toBeUndefined();
    expect(env.V2_START_BLOCK).toBeUndefined();
    expect(env.START_BLOCK).toBe(61_000_000);
    expect(env.USDG).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(env.MARKET).toBe("NVDA");
    expect(env.END_BLOCK).toBeUndefined();
    expect(env.LIVE_READ_TIMEOUT_MS).toBe(8000);
    expect(env.V2_PRODUCTION).toBe(false);
    expect(env.V2_REWARDS_DISTRIBUTORS).toEqual([]);
    const overridden = await boot({ VAULT_ADDRESS: VAULT, START_BLOCK: "1", SEAPORT: addr(0xab).toUpperCase().replace("0X", "0x") });
    expect(overridden.SEAPORT).toBe(getAddress(addr(0xab)));
  });

  it("rejects a malformed address in a defaulted, an aliased and a v2 variable", async () => {
    await expect(boot({ VAULT_ADDRESS: VAULT, START_BLOCK: "1", USDG: "0x123" }))
      .rejects.toThrow('USDG="0x123" is not a valid address');
    await expect(boot({ FACTORY: "factory" })).rejects.toThrow('FACTORY_ADDRESS="factory" is not a valid address');
    await expect(boot({ ...V2_CORE, V2_ORDER_BOOK: "0xnope" }))
      .rejects.toThrow('V2_ORDER_BOOK="0xnope" is not a valid address');
    await expect(boot({ ...V2_CORE, V2_KEEPER_REWARDS: "0xnope" }))
      .rejects.toThrow('V2_KEEPER_REWARDS="0xnope" is not a valid address');
  });

  it("requires a non-negative integer START_BLOCK for a legacy product", async () => {
    await expect(boot({ VAULT_ADDRESS: VAULT })).rejects.toThrow("Missing required env var START_BLOCK");
    await expect(boot({ VAULT_ADDRESS: VAULT, START_BLOCK: "-1" })).rejects.toThrow("is not a non-negative integer");
    await expect(boot({ VAULT_ADDRESS: VAULT, START_BLOCK: "1.5" })).rejects.toThrow('START_BLOCK="1.5"');
  });

  it("factory mode warns once when MARKET is left at the NVDA default, and not when it is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await boot({ FACTORY_ADDRESS: VAULT, START_BLOCK: "5" })).MARKET).toBe("NVDA");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("MARKET is not");
      warn.mockClear();
      const env = await boot({ FACTORY_ADDRESS: VAULT, START_BLOCK: "5", MARKET: "AAPL" });
      expect(env.MARKET).toBe("AAPL");
      expect(warn).not.toHaveBeenCalled();
      expect(() => env.vaultAddress()).toThrow("vault code path reached with VAULT_ADDRESS unset");
    } finally {
      warn.mockRestore();
    }
  });

  it("v2-only mode: requires every core address, and the legacy START_BLOCK follows V2_START_BLOCK", async () => {
    const env = await boot(V2_CORE);
    expect(env.V2_CLEARINGHOUSE?.toLowerCase()).toBe(V2_CORE.V2_CLEARINGHOUSE);
    expect(env.V2_START_BLOCK).toBe(100);
    expect(env.START_BLOCK).toBe(100);
    expect(env.V2_EXPIRY_CALENDAR).toBeUndefined();
    expect(env.V2_FLYWHEEL_START_BLOCK).toBeUndefined();
    expect(env.V2_EARN_START_BLOCK).toBeUndefined();
    expect(env.V2_HOUSE_START_BLOCK).toBeUndefined();
    const { V2_AUTO_ROLLER: _dropped, ...missing } = V2_CORE;
    await expect(boot(missing)).rejects.toThrow("Missing required address env var V2_AUTO_ROLLER when V2_CLEARINGHOUSE is set");
    const { V2_START_BLOCK: _noStart, ...noStart } = V2_CORE;
    await expect(boot(noStart)).rejects.toThrow("Missing required env var V2_START_BLOCK");
  });

  it("refuses any v2 variable set without V2_CLEARINGHOUSE", async () => {
    const legacy = { VAULT_ADDRESS: VAULT, START_BLOCK: "1" };
    for (const name of ["V2_ORDER_BOOK", "V2_EXPIRY_CALENDAR"]) {
      await expect(boot({ ...legacy, [name]: addr(9) })).rejects.toThrow(`${name} is set without V2_CLEARINGHOUSE`);
    }
    await expect(boot({ ...legacy, V2_REWARDS_DISTRIBUTORS: "[]" }))
      .rejects.toThrow("V2_REWARDS_DISTRIBUTORS is set without V2_CLEARINGHOUSE");
    await expect(boot({ ...legacy, V2_START_BLOCK: "5" })).rejects.toThrow("V2_START_BLOCK is set without V2_CLEARINGHOUSE");
  });

  it("resolves reward distributors from the JSON list and the legacy maker variable", async () => {
    const maker = addr(0xd1);
    const lender = addr(0xd2);
    const list = JSON.stringify([{ program: "maker", address: maker }, { program: "lender", address: lender }]);
    const env = await boot({ ...V2_CORE, V2_REWARDS_DISTRIBUTORS: list });
    expect(env.V2_REWARDS_DISTRIBUTORS.map((d) => d.program)).toEqual(["maker", "lender"]);
    expect(env.V2_REWARDS_DISTRIBUTOR?.toLowerCase()).toBe(maker);
    const legacyOnly = await boot({ ...V2_CORE, V2_REWARDS_DISTRIBUTOR: lender });
    expect(legacyOnly.V2_REWARDS_DISTRIBUTOR?.toLowerCase()).toBe(lender);
    expect(legacyOnly.V2_REWARDS_DISTRIBUTORS).toEqual([{ program: "maker", address: legacyOnly.V2_REWARDS_DISTRIBUTOR }]);
  });

  it("pairs the flywheel variables and requires a non-zero flywheel start block", async () => {
    const splitter = { V2_FEE_SPLITTER: addr(0xe1), V2_FLYWHEEL_TOKEN_ADDRESS: addr(0xe2) };
    await expect(boot({ ...V2_CORE, V2_BUYBACK_EXECUTOR: addr(0xe3), V2_FLYWHEEL_TOKEN_ADDRESS: addr(0xe2) }))
      .rejects.toThrow("V2_BUYBACK_EXECUTOR is set without V2_FEE_SPLITTER");
    await expect(boot({ ...V2_CORE, V2_FEE_SPLITTER: addr(0xe1) }))
      .rejects.toThrow("Set V2_FEE_SPLITTER and V2_FLYWHEEL_TOKEN_ADDRESS together");
    await expect(boot({ ...V2_CORE, ...splitter })).rejects.toThrow("Missing required env var V2_FLYWHEEL_START_BLOCK");
    await expect(boot({ ...V2_CORE, ...splitter, V2_FLYWHEEL_START_BLOCK: "0" }))
      .rejects.toThrow("V2_FLYWHEEL_START_BLOCK must be a deployment block above zero");
    await expect(boot({ ...V2_CORE, V2_FLYWHEEL_START_BLOCK: "7" }))
      .rejects.toThrow("V2_FLYWHEEL_START_BLOCK is set without V2_FEE_SPLITTER");
    expect((await boot({ ...V2_CORE, ...splitter, V2_FLYWHEEL_START_BLOCK: "7" })).V2_FLYWHEEL_START_BLOCK).toBe(7);
  });

  it("requires a non-zero earn start block with either lending contract, and refuses it alone", async () => {
    await expect(boot({ ...V2_CORE, V2_ZAP_HELPER: addr(0xf1), V2_EARN_START_BLOCK: "0" }))
      .rejects.toThrow("V2_EARN_START_BLOCK must be a deployment block above zero");
    await expect(boot({ ...V2_CORE, V2_EARN_START_BLOCK: "9" }))
      .rejects.toThrow("V2_EARN_START_BLOCK is set without V2_EARN_VAULT or V2_ZAP_HELPER");
    expect((await boot({ ...V2_CORE, V2_EARN_VAULT: addr(0xf2), V2_EARN_START_BLOCK: "9" })).V2_EARN_START_BLOCK).toBe(9);
  });

  it("requires a non-zero house start block with the house factory, and refuses it alone", async () => {
    await expect(boot({ ...V2_CORE, V2_HOUSE_VAULT_FACTORY: addr(0xf3), V2_HOUSE_START_BLOCK: "0" }))
      .rejects.toThrow("V2_HOUSE_START_BLOCK must be a deployment block above zero");
    await expect(boot({ ...V2_CORE, V2_HOUSE_START_BLOCK: "11" }))
      .rejects.toThrow("V2_HOUSE_START_BLOCK is set without V2_HOUSE_VAULT_FACTORY");
    expect((await boot({ ...V2_CORE, V2_HOUSE_VAULT_FACTORY: addr(0xf3), V2_HOUSE_START_BLOCK: "11" })).V2_HOUSE_START_BLOCK)
      .toBe(11);
  });

  it("reads V2_PRODUCTION as exactly 1 or 0 and refuses anything else", async () => {
    expect((await boot({ ...V2_CORE, V2_PRODUCTION: "1" })).V2_PRODUCTION).toBe(true);
    expect((await boot({ ...V2_CORE, V2_PRODUCTION: "0" })).V2_PRODUCTION).toBe(false);
    await expect(boot({ ...V2_CORE, V2_PRODUCTION: "true" })).rejects.toThrow('V2_PRODUCTION="true" must be 1');
  });

  it("validates PRICING_URL only for a v2 process and strips one trailing slash", async () => {
    expect((await boot({ VAULT_ADDRESS: VAULT, START_BLOCK: "1", PRICING_URL: "not a url" })).PRICING_URL)
      .toBe("not a url");
    expect((await boot({ ...V2_CORE, PRICING_URL: "https://pricing.invalid/api/" })).PRICING_URL)
      .toBe("https://pricing.invalid/api");
    expect((await boot({ ...V2_CORE })).PRICING_URL).toBeUndefined();
    await expect(boot({ ...V2_CORE, PRICING_URL: "not a url" })).rejects.toThrow('PRICING_URL="not a url" is not a valid URL');
    await expect(boot({ ...V2_CORE, PRICING_URL: "ftp://pricing.invalid" })).rejects.toThrow("must use http or https");
  });

  it("parses END_BLOCK and LIVE_READ_TIMEOUT_MS, falling back to 8s on a nonsensical timeout", async () => {
    const legacy = { VAULT_ADDRESS: VAULT, START_BLOCK: "1" };
    const env = await boot({ ...legacy, END_BLOCK: "123", LIVE_READ_TIMEOUT_MS: "2500", PGLITE_DIRECTORY: "/tmp/x" });
    expect(env.END_BLOCK).toBe(123);
    expect(env.LIVE_READ_TIMEOUT_MS).toBe(2500);
    expect(env.PGLITE_DIRECTORY).toBe("/tmp/x");
    await expect(boot({ ...legacy, END_BLOCK: "abc" })).rejects.toThrow('END_BLOCK="abc" is not a non-negative integer');
    for (const bad of ["0", "-5", "soon"]) {
      expect((await boot({ ...legacy, LIVE_READ_TIMEOUT_MS: bad })).LIVE_READ_TIMEOUT_MS).toBe(8000);
    }
  });
});
