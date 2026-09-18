/* -------------------------------------------------------------------------------------------------
 * ops/v2/rehearse/stack.mjs — how the rehearsal starts its services, shared by step 2 (the live stack) and step 4 (the
 * failure drills: the indexer restarted after an outage, a second cranker, drill-local crankers and MM bots).
 *
 *   run(label, cmd, args)          a command to completion, output in logs/<label>.log
 *   restoreGenerated(file)         git checkout of a generated file a service build rewrote
 *   startIndexer(S)                gen:v2-registry from the rehearsal copy, `ponder start` (schema o203, PGlite under
 *                                  out/pglite, kept unless fresh: true), /ready, the generated registry restored
 *   botEnv(S, secrets, ...)        the environment of keeper/src/index.ts in one V2_MODE (anvil public dev keys only)
 *   startBot(S, secrets, ...)      one bot process, recorded in services.json, /health ok
 * ------------------------------------------------------------------------------------------------- */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  INDEXER_URL, LOGS, OUT, PORTS, PRICING_URL, RELAY_URL, ROOT, RPC, fail, getJson, keyOf, readJson, startService, until,
} from "./lib.mjs";

export const GIT = "/opt/homebrew/bin/git";
export const TSX_KEEPER = path.join(ROOT, "keeper", "node_modules", ".bin", "tsx");
export const INDEXER_GENERATED = "indexer/lib/v2/marketRegistry.generated.ts";
export const WEB_GENERATED = "web/lib/markets.generated.ts";
export const SECRETS_FILE = path.join(OUT, "secrets.json");

export function run(label, cmd, args, { cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    const log = path.join(LOGS, `${label}.log`);
    const fd = openSync(log, "w");
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
    child.on("close", (code) => {
      closeSync(fd);
      resolve({ code, log, text: readFileSync(log, "utf8") });
    });
  });
}

export function restoreGenerated(file) {
  execFileSync(GIT, ["-C", ROOT, "checkout", "--", file]);
}

export const generatedClean = (file) => execFileSync(GIT, ["-C", ROOT, "status", "--porcelain", "--", file]).toString().trim() === "";

export const loadSecrets = () => readJson(SECRETS_FILE);

/**
 * indexer-v2 (Ponder) on the fork. `fresh` drops the PGlite database first (step 2); without it Ponder resumes from the
 * checkpoint it wrote before it was stopped (step 4's indexer-down drill). The generated registry is restored as soon as
 * /ready answers, or on failure.
 */
export async function startIndexer(S, { fresh = true, label = "indexer", timeoutMs = 600_000 } = {}) {
  const C = S.contracts;
  const gen = await run(`${label}-gen-v2-registry`, "pnpm", ["gen:v2-registry"], { cwd: path.join(ROOT, "indexer"), env: { MARKETS_REGISTRY: S.registryCopy } });
  if (gen.code !== 0) {
    restoreGenerated(INDEXER_GENERATED);
    fail(`gen:v2-registry failed (log ${gen.log})`);
  }
  const pglite = path.join(OUT, "pglite");
  if (fresh) rmSync(pglite, { recursive: true, force: true });
  const indexerEnv = {
    PONDER_RPC_URL_4663: RPC, V2_CLEARINGHOUSE: C.clearinghouse, V2_ORDER_BOOK: C.orderBook, V2_SETTLEMENT_ORACLE: C.settlementOracle, V2_AUTO_ROLLER: C.autoRoller,
    V2_MAKER_REGISTRY: C.makerRegistry, V2_EXPIRY_CALENDAR: C.expiryCalendar, V2_KEEPER_REWARDS: C.keeperRewards, V2_START_BLOCK: String(S.deployBlock), PRICING_URL,
    PGLITE_DIRECTORY: pglite, DATABASE_SCHEMA: "o203", PORT: String(PORTS.indexer),
  };
  const parent = { ...process.env };
  for (const k of ["DATABASE_URL", "DATABASE_PRIVATE_URL", "END_BLOCK", "VAULT_ADDRESS", "VAULT", "START_BLOCK", "FACTORY_ADDRESS", "FACTORY"]) delete parent[k];
  try {
    startService("indexer", path.join(ROOT, "indexer/node_modules/.bin/ponder"), ["start", "--schema", "o203", "--port", String(PORTS.indexer)], { cwd: path.join(ROOT, "indexer"), port: PORTS.indexer, env: { ...parent, ...indexerEnv }, inheritEnv: false });
    await until("indexer /ready", async () => (await fetch(`${INDEXER_URL}/ready`)).ok, { service: "indexer", timeoutMs, intervalMs: 2_000 });
  } finally {
    restoreGenerated(INDEXER_GENERATED);
  }
}

const HEALTH_PORT_VAR = { cranker: "CRANKER_PORT", mm: "MM_PORT", pricer: "PRICER_PORT" };
const KEY_VAR = { cranker: "CRANKER_PK", mm: "MM_QUOTER_PK", pricer: "PRICER_PK" };

/** keeper/src/index.ts's environment in one mode: the registry copy, the relay for alerts, a public dev key. */
export function botEnv(S, secrets, { mode, port, keyRole, db, indexer = true, extra = {} }) {
  const parent = { ...process.env };
  for (const k of Object.keys(parent)) if (/^(V2_|MM_|CRANKER_|PRICER_|KEEPER_|RH_RPC|ALERT_)/.test(k)) delete parent[k];
  return {
    ...parent,
    V2_MODE: mode, RH_RPC: RPC, CHAIN_ID: "4663", V2_REGISTRY_PATH: S.registryCopy, KEEPER_DB_PATH: db,
    POLL_INTERVAL_MS: "5000", KEEPER_LOG_LEVEL: "info", ALERT_WEBHOOK: `${RELAY_URL}/alert`, ALERT_WEBHOOK_TOKEN: secrets.relayToken,
    ...(indexer ? { INDEXER_URL } : {}),
    ...(mode === "mm" ? { PRICING_URL, MM_KILL_TOKEN: secrets.mmKillToken, MAKER_VAULT: S.contracts.makerVault } : {}),
    ...(mode === "pricer" ? { PRICING_URL } : {}),
    [KEY_VAR[mode]]: keyOf(keyRole),
    [HEALTH_PORT_VAR[mode]]: String(port),
    ...extra,
  };
}

/**
 * One bot (keeper/src/index.ts) recorded as `name` in services.json with its own SQLite journal. `freshDb` removes the
 * journal first. Resolves once /health leaves "starting"; fails unless it is "ok".
 */
export async function startBot(S, secrets, { name, mode, port, keyRole, db = path.join(OUT, "db", `${name}.db`), freshDb = true, indexer = true, extra = {}, timeoutMs = 240_000 }) {
  if (freshDb) for (const f of ["", "-wal", "-shm"]) rmSync(`${db}${f}`, { force: true });
  startService(name, TSX_KEEPER, ["src/index.ts"], { cwd: path.join(ROOT, "keeper"), port, env: botEnv(S, secrets, { mode, port, keyRole, db, indexer, extra }), inheritEnv: false });
  const h = await until(`${name} /health`, async () => {
    const r = await getJson(`http://127.0.0.1:${port}/health`);
    return r.status !== "starting" ? r : null;
  }, { service: name, timeoutMs, intervalMs: 1_000 });
  if (h.status !== "ok") fail(`${name} /health ${h.status}`);
  return { db, health: h };
}
