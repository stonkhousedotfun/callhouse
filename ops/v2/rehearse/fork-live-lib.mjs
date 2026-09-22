/* -------------------------------------------------------------------------------------------------
 * Pure helpers for ops/v2/rehearse.sh --fork-live (O3-005). No anvil, no network.
 *
 * The live-set fork reads the committed registry's v2.contracts addresses (EXPECTED_ADDRESS_COUNT of them), impersonates on the
 * fork only, and never reads ~/.callhouse-keys. Numeric service env is rendered here so tests can
 * assert the rendered blob has no key-path.
 * ------------------------------------------------------------------------------------------------- */
export const LIVE_SERVICES = ["cranker", "indexer", "mm-bot", "pricer", "pricing", "monitor"];
export const CONTRACT_KEYS = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor",
];
export const SOURCE_KEYS = ["chainlink", "univ3", "dataStreams"];
/**
 * How many live addresses a --fork-live run expects, DERIVED rather than written down. It was the
 * literal `13` in two places, which is 10 CONTRACT_KEYS + 3 SOURCE_KEYS and therefore kept passing no
 * matter what the key lists said. A count that agrees with itself is not a check.
 *
 * `accessManager` is deliberately NOT in CONTRACT_KEYS. --fork-live forks the ALREADY-LIVE set, that set
 * is v7, and v7 has no AccessManager at all (`ops/markets/v7-legacy.json` v2.contracts has no such key --
 * the manager arrives with v8). Adding it here would make the only legitimate use of this harness throw.
 * The v8 case is handled by refusing the registry outright in {assertForkLiveRegistry}, not by widening
 * a list that describes v7.
 */
export const EXPECTED_ADDRESS_COUNT = CONTRACT_KEYS.length + SOURCE_KEYS.length;
/**
 * WHICH REGISTRY --fork-live READS, and why it is NOT the one the numbered steps read.
 *
 * `lib.mjs` exports `REGISTRY` pointing at `ops/markets/tier1.json`, and steps 1-5 need exactly that: they
 * DEPLOY v8 onto a fork, so the v8 registry is their input. --fork-live does the opposite -- it forks 4663 at
 * head and impersonates on addresses that are ALREADY DEPLOYED -- and the deployed set is v7, which now lives
 * in `ops/markets/v7-legacy.json`. tier1.json became the v8 registry with every contract address null, so the
 * fork-live path pointed at it could only ever refuse (assertForkLiveRegistry) or, before that guard existed,
 * die on a null address.
 *
 * The shared `REGISTRY` constant is deliberately left alone: moving it would move the numbered steps too.
 * Only this path moves. `--registry <path>` overrides, for a soak against some other committed registry.
 *
 * Returned as a REPO-RELATIVE string so this module stays pure -- no fs, no path, no ROOT.
 */
export const FORK_LIVE_REGISTRY = "ops/markets/v7-legacy.json";

/** `--registry <path>` if given, else {FORK_LIVE_REGISTRY}. Pure: resolve it against ROOT at the call site. */
export function forkLiveRegistryArg(argv) {
  const i = argv.indexOf("--registry");
  if (i === -1) return FORK_LIVE_REGISTRY;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--registry needs a path");
  return value;
}

export const KEY_PATH_RE = /callhouse-keys|\/\.callhouse\/|PRIVATE_KEY_FILE|KEYSTORE_PATH/i;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseServices(raw) {
  if (raw == null || String(raw).trim() === "") return ["cranker", "indexer"];
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("--services is empty");
  const unknown = parts.filter((p) => !LIVE_SERVICES.includes(p));
  if (unknown.length) throw new Error(`unknown --services entry: ${unknown.join(", ")} (want ${LIVE_SERVICES.join("|")})`);
  return [...new Set(parts)];
}

/**
 * --fork-live is the WRONG harness for a v8 soak and this is where that is enforced.
 *
 * It forks chain 4663 at head and impersonates on the addresses the registry already holds, so it can only
 * ever measure what is already deployed -- which is v7. Pointed at a v8 registry it would either throw on
 * the still-null addresses (today) or, once they are filled, quietly measure a v8 set through a key list
 * that has no `accessManager` in it and report success. Refusing by interfaceVersion stops both, and names
 * the harness that is correct instead, because "this is wrong" without "use that" just gets worked around.
 */
export function assertForkLiveRegistry(registry) {
  const v = registry?.v2?.interfaceVersion;
  if (v === 8 || v === "8") {
    throw new Error(
      "--fork-live cannot soak an INTERFACE_VERSION 8 registry: it forks the already-live set, which is v7. " +
        "Use the numbered rehearsal stack instead (ops/v2/rehearse.sh, steps 1-5), which deploys v8 onto the fork.",
    );
  }
  return registry;
}

/**
 * Every contract the registry DECLARES must be enumerated by this harness.
 *
 * {thirteenAddresses} already asks the forward question -- is every name in the table present in the
 * registry. Nothing asked the converse, and the converse is the direction that fails silently: a
 * contract added to the forked set and not added to CONTRACT_KEYS is not a missing address, it is a
 * contract nobody looked at, and the rehearsal still reports success. On a v8 registry that contract
 * is `accessManager`, the authority deciding whether any restricted call is allowed.
 *
 * This is the assertion rather than a longer list on purpose. Adding `accessManager` to CONTRACT_KEYS
 * would break the only legitimate use of this harness (see the note above the list) and would do
 * nothing about the NEXT unlisted contract. `sources` is descended into rather than compared as a
 * contract name, because SOURCE_KEYS is what describes it.
 *
 * Separate from {assertForkLiveRegistry} and kept alongside it: that one refuses v8 outright, which
 * does not cover a new contract appearing in a v7 registry. They answer different questions.
 */
export function assertRegistryContractsCovered(registry) {
  const C = registry?.v2?.contracts;
  if (!C || typeof C !== "object") throw new Error("registry.v2.contracts missing");
  const listed = new Set(CONTRACT_KEYS);
  const unlisted = Object.keys(C).filter((k) => k !== "sources" && !listed.has(k)).sort();
  if (unlisted.length > 0) {
    throw new Error(
      `registry.v2.contracts declares ${unlisted.length} contract(s) this fork rehearsal does not ` +
        `enumerate: ${unlisted.join(", ")}. CONTRACT_KEYS in ops/v2/rehearse/fork-live-lib.mjs describes ` +
        "the v7 live set. Refuse the registry, or widen the list only if this harness genuinely forks " +
        "the set that registry belongs to; what is not acceptable is reporting success having never " +
        "read that contract.",
    );
  }
  const S = C.sources;
  if (S && typeof S === "object") {
    const listedSources = new Set(SOURCE_KEYS);
    const unlistedSources = Object.keys(S).filter((k) => !listedSources.has(k)).sort();
    if (unlistedSources.length > 0) {
      throw new Error(
        `registry.v2.contracts.sources declares ${unlistedSources.length} source(s) this fork rehearsal ` +
          `does not enumerate: ${unlistedSources.join(", ")}. Add them to SOURCE_KEYS in ` +
          "ops/v2/rehearse/fork-live-lib.mjs, or refuse the registry.",
      );
    }
  }
  return registry;
}

export function thirteenAddresses(registry) {
  assertForkLiveRegistry(registry);
  // Bind the table to the registry BEFORE any address is read: the unenumerated contract is the
  // silent case, and reading the listed ten first would report success having skipped it.
  assertRegistryContractsCovered(registry);
  const C = registry?.v2?.contracts;
  if (!C || typeof C !== "object") throw new Error("registry.v2.contracts missing");
  const out = {};
  for (const k of CONTRACT_KEYS) {
    const a = C[k];
    if (typeof a !== "string" || !ADDRESS_RE.test(a)) throw new Error(`v2.contracts.${k} is not a live address`);
    out[k] = a;
  }
  const S = C.sources;
  if (!S || typeof S !== "object") throw new Error("registry.v2.contracts.sources missing");
  for (const k of SOURCE_KEYS) {
    const a = S[k];
    if (typeof a !== "string" || !ADDRESS_RE.test(a)) throw new Error(`v2.contracts.sources.${k} is not a live address`);
    out[`sources.${k}`] = a;
  }
  if (Object.keys(out).length !== EXPECTED_ADDRESS_COUNT) {
    throw new Error(`expected ${EXPECTED_ADDRESS_COUNT} live addresses, got ${Object.keys(out).length}`);
  }
  return out;
}

export function nvdaRow(registry) {
  const m = (registry.markets ?? []).find((x) => x.ticker === "NVDA");
  if (!m?.asset || !ADDRESS_RE.test(m.asset)) throw new Error("registry has no NVDA.asset");
  return m;
}

export function assertForkOnlyEnv(env) {
  const blob = `${Object.keys(env).join("\n")}\n${Object.values(env).join("\n")}`;
  if (KEY_PATH_RE.test(blob)) throw new Error("rendered env mentions a real key path");
}

/** Tight cranker env: anvil public junk key only, no parent process secrets. */
export function crankerEnv({ rpc, registryPath, db, port, pk, indexerUrl, alertWebhook, alertToken }) {
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    V2_MODE: "cranker",
    RH_RPC: rpc,
    CHAIN_ID: "4663",
    V2_REGISTRY_PATH: registryPath,
    KEEPER_DB_PATH: db,
    POLL_INTERVAL_MS: "5000",
    KEEPER_LOG_LEVEL: "info",
    CRANKER_PK: pk,
    CRANKER_PORT: String(port),
  };
  if (indexerUrl) env.INDEXER_URL = indexerUrl;
  if (alertWebhook) {
    env.ALERT_WEBHOOK = alertWebhook;
    if (alertToken) env.ALERT_WEBHOOK_TOKEN = alertToken;
  }
  assertForkOnlyEnv(env);
  return env;
}

export function indexerEnv({ rpc, addresses, startBlock, pglite, port }) {
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    PONDER_RPC_URL_4663: rpc,
    V2_CLEARINGHOUSE: addresses.clearinghouse,
    V2_ORDER_BOOK: addresses.orderBook,
    V2_SETTLEMENT_ORACLE: addresses.settlementOracle,
    V2_AUTO_ROLLER: addresses.autoRoller,
    V2_MAKER_REGISTRY: addresses.makerRegistry,
    V2_EXPIRY_CALENDAR: addresses.expiryCalendar,
    V2_KEEPER_REWARDS: addresses.keeperRewards,
    V2_START_BLOCK: String(startBlock),
    PGLITE_DIRECTORY: pglite,
    DATABASE_SCHEMA: "forklive",
    PORT: String(port),
  };
  assertForkOnlyEnv(env);
  return env;
}

export function reportShapeOk(report) {
  if (!report || report.mode !== "fork-live") return false;
  if (typeof report.forkBlock !== "number" || report.forkBlock < 1) return false;
  if (!report.addresses || Object.keys(report.addresses).length !== EXPECTED_ADDRESS_COUNT) return false;
  if (!report.nvda || typeof report.nvda.identical !== "boolean") return false;
  if (!report.services || typeof report.services !== "object") return false;
  if (report.keys?.callhouseKeysRead !== false) return false;
  return true;
}
