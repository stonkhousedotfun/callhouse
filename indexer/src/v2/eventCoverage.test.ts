/**
 * Concrete ABI -> Ponder source -> handler -> SCHEMA census at the attached v8 interface.
 *
 * Two layers, because source-level coverage and storage-level coverage are different problems and
 * T-301 could only fence the first. A registered source whose event has no handler is read and
 * dropped; a handler whose fact has nowhere to persist is read, processed and dropped just as
 * silently. Both fail here, and both are proved by breaking at the bottom of the test.
 *
 * T-295 closed the 49 events that carried independent facts by adding the column AND the handler
 * together (src/v2/adminConfig.ts, src/v2/stateFacts.ts). What remains is in DELIBERATE with a
 * reason per event, and EarnVault:Funded, which OrderBook funding already carries. Eight concrete
 * emitters still have no source because their addresses are null pending the v8 broadcast; never
 * invent an address to make this census green.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const abiDir = fileURLToPath(new URL("../../../ops/abis/v2/", import.meta.url));
const handlerDir = fileURLToPath(new URL("./", import.meta.url));
const buybackSource = "BuybackExecutor";

/**
 * What is STILL not handled on a configured source, with the reason for each one individually.
 * T-295 handled the other 49 by giving each fact a column; an aggregate "the rest are ignorable"
 * is exactly what this row existed to prevent, so anything added here needs its own sentence.
 */
const DELIBERATE: Record<string, string> = {
  "EarnVault:Approval":
    "ERC-20 allowance on Earn vault shares. No consumer: no view, route or rule reads an allowance, " +
    "and the spender who set it can read it on chain. Give it a column the day something displays it.",
  "HouseVault:Approval":
    "The same fact for House vault shares, and the same reason. Note this is NOT Transfer - share " +
    "movements are indexed in v2HouseShareBalance; only the allowance is skipped.",
  "HouseVault:ProtocolAccountsConfirmed":
    "T-422 debt. The one-shot arming flag HouseVault.sol:952-954 sets the first time a protocol " +
    "account is marked blocked. The same transaction always emits ProtocolAccountSet, which IS " +
    "handled (src/v2/houseVault.ts:410), so the fact is derivable; what is not indexed is the " +
    "moment the vault became armed. Give it a column the day a view shows arming state.",
};
const pendingKeys = Object.keys(DELIBERATE).sort();
const canonicalKeys = ["EarnVault:Funded"]; // OrderBook funding attempts are the canonical projection.
const awaitingBroadcast = [
  "ChainlinkFeedSource", "DataStreamsSource", "Erc4626VenueAdapter", "Hedger",
  "StockLoanAdapter", "StockVenueAdapter", "UniV3PayoutAdapter", "UniV3TwapSource",
];

type Row = { source: string; event: string; abi: string; handler: string | null };

function concreteExports(): Map<string, { name: string; path: string }[]> {
  const result = new Map<string, { name: string; path: string }[]>();
  for (const file of readdirSync(abiDir).filter((name) =>
    name.endsWith(".json") && /^[A-Z]/.test(name) && !/^I[A-Z]/.test(name) && name !== "V2Errors.json"
  )) {
    const source = file.slice(0, -5);
    const path = join(abiDir, file);
    const abi = JSON.parse(readFileSync(path, "utf8")) as { type: string; name?: string }[];
    const events = abi.filter((item) => item.type === "event" && item.name !== undefined)
      .map((item) => ({ name: item.name!, path }));
    if (events.length === 0) throw new Error(`${file} has no concrete events`);
    result.set(source, events);
  }
  return result;
}

/** Parse call expressions, not text: a commented-out registration must not count. */
function registrationsFromSource(file: string, source: string): Map<string, string> {
  const handlers = new Map<string, string>();
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "on" && ts.isIdentifier(node.expression.expression) &&
      /^(?:ponder|v2\w*Ponder)$/.test(node.expression.expression.text)
    ) {
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isStringLiteral(arg)) {
        throw new Error(`dynamic handler name in ${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
      }
      const key = arg.text;
      if (handlers.has(key)) throw new Error(`duplicate handler ${key} in ${file}`);
      handlers.set(key, `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return handlers;
}

function registrations(): Map<string, string> {
  const handlers = new Map<string, string>();
  for (const file of readdirSync(handlerDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const path = join(handlerDir, file);
    for (const [key, location] of registrationsFromSource(file, readFileSync(path, "utf8"))) {
      if (handlers.has(key)) throw new Error(`duplicate handler ${key}: ${handlers.get(key)} and ${location}`);
      handlers.set(key, location);
    }
  }
  return handlers;
}

/**
 * Which schema tables a handler actually writes. Resolved through same-file helpers, because
 * src/v2/earn.ts and friends put the write one call away from the registration; a scan that only
 * looked inside the callback would call those handlers unpersisted and be wrong.
 */
function handlerTables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(handlerDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const path = join(handlerDir, file);
    const ast = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = new Map<string, ts.Node>();
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) functions.set(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) functions.set(node.name.text, node.initializer);
      ts.forEachChild(node, collect);
    };
    collect(ast);
    const tablesOf = (node: ts.Node, seen: Set<string>): Set<string> => {
      const tables = new Set<string>();
      const visit = (inner: ts.Node): void => {
        if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "schema") {
          tables.add(inner.name.text);
        }
        if (ts.isIdentifier(inner) && functions.has(inner.text) && !seen.has(inner.text)) {
          seen.add(inner.text);
          for (const table of tablesOf(functions.get(inner.text)!, seen)) tables.add(table);
        }
        ts.forEachChild(inner, visit);
      };
      visit(node);
      return tables;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "on" && ts.isIdentifier(node.expression.expression) &&
        /^(?:ponder|v2\w*Ponder)$/.test(node.expression.expression.text)
      ) {
        const [name, callback] = node.arguments;
        if (name !== undefined && ts.isStringLiteral(name)) {
          out.set(name.text, callback === undefined ? [] : [...tablesOf(callback, new Set())].sort());
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return out;
}

/** The tables ponder.schema.ts actually declares. A handler may only write one of these. */
function schemaTables(): Set<string> {
  const file = fileURLToPath(new URL("../../ponder.schema.ts", import.meta.url));
  const ast = ts.createSourceFile("ponder.schema.ts", readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tables = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "onchainTable"
    ) tables.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return tables;
}

/**
 * The second layer. A handler that writes nothing, or writes to a table the schema does not
 * declare, reads its event and drops the fact exactly as an unregistered event does - and neither
 * the type checker nor a passing suite says so, because the code runs and stores nothing.
 */
function strictPersistence(tables: ReadonlyMap<string, string[]>, declared: ReadonlySet<string>) {
  const faults: string[] = [];
  for (const [key, written] of tables) {
    if (written.length === 0) {
      faults.push(`${key} writes no schema table`);
      continue;
    }
    for (const table of written) {
      if (!declared.has(table)) faults.push(`${key} writes schema.${table}, which ponder.schema.ts does not declare`);
    }
  }
  if (faults.length > 0) throw new Error(`handlers whose facts cannot persist: ${faults.join("; ")}`);
}

function matrix(
  exported: Map<string, { name: string; path: string }[]>,
  sources: Map<string, readonly { type: string; name?: string }[]>,
  handlers: Map<string, string>,
): Row[] {
  const rows: Row[] = [];
  const seenSources = new Set<string>();
  for (const [concrete, events] of exported) {
    const source = concrete === "V4BuybackExecutor" ? buybackSource : concrete;
    const configured = sources.get(source);
    if (configured !== undefined) {
      seenSources.add(source);
      const configuredEvents = [...new Set(configured.filter((item) => item.type === "event").map((item) => item.name))].sort();
      expect(configuredEvents, `${source} Ponder ABI differs from ${concrete}.json`)
        .toEqual(events.map((item) => item.name).sort());
    }
    for (const item of events) {
      const key = `${source}:${item.name}`;
      rows.push({ source, event: item.name, abi: item.path, handler: configured === undefined ? null : handlers.get(key) ?? null });
    }
  }
  expect([...sources.keys()].sort(), "every v2 source has a concrete ABI export")
    .toEqual([...seenSources].sort());
  for (const key of handlers.keys()) {
    const [source] = key.split(":");
    if (source === "V2Clock" || source === "V2PnlClock") continue;
    expect(rows.some((row) => `${row.source}:${row.event}` === key), `orphan handler ${key}`).toBe(true);
  }
  return rows;
}

function strictCoverage(rows: Row[], sources: ReadonlyMap<string, unknown>) {
  const unhandled = rows.filter((row) => sources.has(row.source) && row.handler === null);
  if (unhandled.length > 0) {
    throw new Error(`unhandled registered-source events: ${unhandled.map((row) => `${row.source}:${row.event}`).join(", ")}`);
  }
}

describe("concrete v8 event coverage", () => {
  it("accounts for every exported event, configured source and actual handler without hiding the pending debt", async () => {
    vi.resetModules();
    vi.stubEnv("PONDER_RPC_URL_4663", "https://example.invalid/rpc");
    const addresses = [
      "V2_CLEARINGHOUSE", "V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER",
      "V2_MAKER_REGISTRY", "V2_EXPIRY_CALENDAR", "V2_KEEPER_REWARDS", "V2_ACCESS_MANAGER",
      "V2_PAYOUT_ROUTER", "V2_FEE_SPLITTER", "V2_BUYBACK_EXECUTOR", "V2_MAKER_VAULT",
      "V2_REWARDS_DISTRIBUTOR", "V2_HOUSE_VAULT_FACTORY", "V2_EARN_VAULT", "V2_ZAP_HELPER",
    ];
    addresses.forEach((key, index) => vi.stubEnv(key, `0x${(index + 1).toString(16).padStart(40, "0")}`));
    vi.stubEnv("V2_FLYWHEEL_TOKEN_ADDRESS", "0x0000000000000000000000000000000000000011");
    vi.stubEnv("V2_START_BLOCK", "64000000");
    vi.stubEnv("V2_FLYWHEEL_START_BLOCK", "63999990");
    vi.stubEnv("V2_HOUSE_START_BLOCK", "64000000");
    vi.stubEnv("V2_EARN_START_BLOCK", "64000000");
    try {
      const { default: config } = await import("../../ponder.config");
      const sources = new Map(Object.entries(config.contracts).map(([name, value]) =>
        [name, value.abi as readonly { type: string; name?: string }[]]
      ));
      const exported = concreteExports();
      const handlers = registrations();
      const rows = matrix(exported, sources, handlers);
      // Includes interfaces, V2Errors and roles; catches a new concrete
      // contract even if its name begins with I and the filter excludes it.
      expect(readdirSync(abiDir).filter((name) => name.endsWith(".json"))).toHaveLength(42);
      expect(exported.size).toBe(25);
      expect(sources.size).toBe(17);
      expect(rows).toHaveLength(201);
      // The named comparison runs before the count, so a lost handler fails naming its event
      // instead of as a bare 110-vs-109.
      const unhandled = rows.filter((row) => sources.has(row.source) && row.handler === null)
        .map((row) => `${row.source}:${row.event}`).sort();
      expect(unhandled).toEqual([...pendingKeys, ...canonicalKeys].sort());
      expect(rows.filter((row) => row.handler !== null)).toHaveLength(160);
      expect(rows.filter((row) => !sources.has(row.source)).map((row) => row.source).filter(
        (name, index, names) => names.indexOf(name) === index
      ).sort()).toEqual(awaitingBroadcast);
      expect(rows.filter((row) => !sources.has(row.source))).toHaveLength(37);
      expect(handlers.has("Clearinghouse:MarketRegistered")).toBe(true); // positive control
      // A textual grep would count this comment as a handler.
      expect(registrationsFromSource("comment-only.ts", '// ponder.on("Clearinghouse:MarketRegistered", fn)').size).toBe(0);
      expect(() => strictCoverage(rows, sources)).toThrow(/unhandled registered-source events:.*EarnVault:Approval/);

      // ---- second layer: every handler's fact has somewhere to persist ----
      const tables = handlerTables();
      const declared = schemaTables();
      expect(tables.size, "every registration was parsed for its writes").toBe(handlers.size);
      strictPersistence(tables, declared);
      // Positive control on the scan itself: a handler this test names must be seen writing the
      // table it obviously writes, or the scan is passing because it found nothing.
      expect(tables.get("SettlementOracle:MarketConfigured")).toContain("v2OracleMarketConfig");
      expect(declared.has("v2OracleMarketConfig")).toBe(true);

      // Break the SCHEMA half: remove the table the handler above writes. The check must name that
      // handler and that table, not merely fail.
      const withoutTable = new Set(declared);
      withoutTable.delete("v2OracleMarketConfig");
      expect(() => strictPersistence(tables, withoutTable))
        .toThrow(/SettlementOracle:MarketConfigured writes schema.v2OracleMarketConfig, which ponder.schema.ts does not declare/);

      // Break the HANDLER half the other way: a registration that writes nothing at all.
      const writesNothing = new Map(tables);
      writesNothing.set("SettlementOracle:MarketConfigured", []);
      expect(() => strictPersistence(writesNothing, declared))
        .toThrow(/SettlementOracle:MarketConfigured writes no schema table/);

      // Remove a known-good handler in memory. The exact matrix must go red rather than
      // passing merely because the subject disappeared from the scan.
      const removed = new Map(handlers);
      removed.delete("Clearinghouse:MarketRegistered");
      const broken = matrix(exported, sources, removed);
      expect(broken.filter((row) => sources.has(row.source) && row.handler === null)
        .map((row) => `${row.source}:${row.event}`).sort()).not.toEqual(unhandled);
      expect(() => strictCoverage(broken, sources)).toThrow(/Clearinghouse:MarketRegistered/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
