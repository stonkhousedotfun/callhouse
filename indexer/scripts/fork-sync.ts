/**
 * X-11: the indexer, synced against a mainnet fork the keeper dry run has driven through three
 * weeks, with every API figure asserted against what the chain and the dry run say happened.
 *
 *   pnpm --filter @callhouse/indexer fork:sync
 *
 * 1. Starts `anvil --fork-url <FORK_URL> --chain-id 4663` on its own port (or uses FORK_SYNC_RPC).
 * 2. Runs `pnpm --filter @callhouse/keeper dryrun` against it: a vault deployed on the fork,
 *    cycle 1 filled out of the money, cycle 2 adopted and unfilled, cycle 3 filled with 9 of 23
 *    assigned and a queued redeem. Reads its run.json.
 * 3. Reads the fork directly (logs and views, never the indexer) for everything run.json does not
 *    record, and cross-checks the two.
 * 4. Starts `ponder start` against the same anvil: chain 4663 via the RPC override, the dry run's
 *    vault and MockRegistry, START_BLOCK = the vault's deploy block, END_BLOCK = the last dry-run
 *    block, a throwaway PGlite database. Waits until /v1/health reports the index head at END_BLOCK.
 * 5. Queries /v1/vault, /v1/cycles, /v1/cycles/:n, /v1/account/:depositor, /v1/listings,
 *    /v1/activity, /v1/health and /graphql, and compares every expected leaf exactly.
 * 6. Prints a summary (exit 0) or the diff (exit 1). Stops every process it started.
 *
 * ENV (all optional)
 *   FORK_SYNC_RPC          use this anvil instead of starting one. Must be a fresh fork unless
 *                          FORK_SYNC_RUN_JSON is also set.
 *   FORK_SYNC_RUN_JSON     skip the dry run and use this run.json; the anvil at FORK_SYNC_RPC must
 *                          be the one that dry run drove, untouched since.
 *   FORK_SYNC_FORK_URL     default https://rpc.mainnet.chain.robinhood.com
 *   FORK_SYNC_ANVIL_PORT   default 8547 (not 8545, so a developer's own anvil is never touched)
 *   FORK_SYNC_API_PORT     default 42169 (the indexer under test)
 *   FORK_SYNC_KEEPER_PORT  default 18797 (the dry run's keeper health server)
 *   FORK_SYNC_OUT          default indexer/.ponder/fork-sync/<utc>: anvil.log, dryrun/, ponder.log,
 *                          pglite/, api/*.json, result.json
 *   FORK_SYNC_TIMEOUT_MS   how long the indexer may take to reach END_BLOCK. Default 180000.
 *
 * WHY START ANVIL HERE. The public RPC serves historical state for only a few thousand trailing
 * blocks (keeper/DRYRUN.md, "Two failures first"). Anvil fetches untouched slots at the fork block
 * lazily, so the fork must be used within minutes of starting it. Starting it in the same process
 * as the run is the only way to guarantee that.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, getAddress } from "viem";

import { readChainFacts, type ChainFacts } from "./fork-sync/chain.ts";
import { compare, formatMismatches, type Json } from "./fork-sync/diff.ts";
import { buildExpectations, graphqlQuery, routesFor, runBlocks, type RunJson } from "./fork-sync/expected.ts";

const INDEXER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(INDEXER_DIR, "..");
const CHAIN_ID = 4663;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const envOr = (name: string, fallback: string): string => {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
};

const FORK_URL = envOr("FORK_SYNC_FORK_URL", "https://rpc.mainnet.chain.robinhood.com");
const ANVIL_PORT = Number(envOr("FORK_SYNC_ANVIL_PORT", "8547"));
const API_PORT = Number(envOr("FORK_SYNC_API_PORT", "42169"));
const KEEPER_PORT = Number(envOr("FORK_SYNC_KEEPER_PORT", "18797"));
const TIMEOUT_MS = Number(envOr("FORK_SYNC_TIMEOUT_MS", "180000"));
const EXTERNAL_RPC = process.env.FORK_SYNC_RPC?.trim() || undefined;
const RUN_JSON = process.env.FORK_SYNC_RUN_JSON?.trim() || undefined;
const OUT = resolve(envOr("FORK_SYNC_OUT", join(INDEXER_DIR, ".ponder", "fork-sync", new Date().toISOString().replace(/[:.]/g, "-"))));
const RPC = EXTERNAL_RPC ?? `http://127.0.0.1:${ANVIL_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const say = (line: string) => process.stdout.write(`[fork-sync ${elapsed()}] ${line}\n`);

/*//////////////////////////////////////////////////////////////
                            PROCESSES
//////////////////////////////////////////////////////////////*/

type Proc = { label: string; child: ChildProcess; exited: Promise<number | null>; tail: string[] };
const procs: Proc[] = [];

/**
 * Start a process in its own process group, logging to a file and keeping the last lines for a
 * failure report. Own group so that stopping it also stops what it spawned (pnpm -> tsx -> node,
 * the ponder shim -> node), and nothing else.
 */
function start(label: string, cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; echo?: (line: string) => boolean }): Proc {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const file = createWriteStream(opts.log);
  const tail: string[] = [];
  const onData = (chunk: Buffer) => {
    file.write(chunk);
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() === "") continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
      if (opts.echo?.(line)) process.stdout.write(`    ${line}\n`);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((done) => {
    child.on("exit", (code) => {
      file.end();
      done(code);
    });
    child.on("error", (err) => {
      tail.push(`spawn error: ${err.message}`);
      done(-1);
    });
  });
  const proc = { label, child, exited, tail };
  procs.push(proc);
  return proc;
}

const alive = (p: Proc) => p.child.exitCode === null && p.child.signalCode === null;

async function stop(p: Proc): Promise<void> {
  if (!alive(p) || p.child.pid === undefined) return;
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-p.child.pid!, s);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  const done = await Promise.race([p.exited.then(() => true), sleep(8000).then(() => false)]);
  if (!done) signal("SIGKILL");
}

async function stopAll(): Promise<void> {
  for (const p of [...procs].reverse()) await stop(p);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    say(`${sig}: stopping ${procs.filter(alive).map((p) => p.label).join(", ") || "nothing"}`);
    void stopAll().then(() => process.exit(130));
  });
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined>, watch?: Proc): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (watch !== undefined && !alive(watch)) {
      throw new Error(`${watch.label} exited (code ${watch.child.exitCode}) while waiting for ${label}. Last lines:\n${watch.tail.join("\n")}`);
    }
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${lastError ? ` (last error: ${lastError})` : ""}`);
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/*//////////////////////////////////////////////////////////////
                               MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<number> {
  mkdirSync(join(OUT, "api"), { recursive: true });
  say(`output: ${OUT}`);

  /* ---- 1. anvil ---- */
  if (EXTERNAL_RPC === undefined) {
    const inUse = await rpc<string>("web3_clientVersion").then(() => true, () => false);
    if (inUse) throw new Error(`port ${ANVIL_PORT} already answers JSON-RPC. Stop that node, set FORK_SYNC_ANVIL_PORT, or point FORK_SYNC_RPC at it deliberately.`);
    say(`starting anvil --fork-url ${FORK_URL} --chain-id ${CHAIN_ID} --port ${ANVIL_PORT}`);
    const anvil = start("anvil", "anvil", ["--fork-url", FORK_URL, "--chain-id", String(CHAIN_ID), "--port", String(ANVIL_PORT)], { cwd: OUT, env: process.env, log: join(OUT, "anvil.log") });
    await waitFor("anvil to answer", 60_000, async () => ((await rpc<string>("eth_chainId")) ? true : undefined), anvil);
  }
  const clientVersion = await rpc<string>("web3_clientVersion");
  if (!clientVersion.toLowerCase().includes("anvil")) throw new Error(`${RPC} is not anvil ("${clientVersion}"). This script warps time and writes storage; refusing.`);
  const chainId = Number(await rpc<string>("eth_chainId"));
  if (chainId !== CHAIN_ID) throw new Error(`${RPC} reports chain ${chainId}, expected ${CHAIN_ID}`);

  /* ---- 2. the keeper dry run ---- */
  let runPath = RUN_JSON;
  if (runPath === undefined) {
    const dryOut = join(OUT, "dryrun");
    say(`keeper dry run: pnpm --filter @callhouse/keeper dryrun (DRYRUN_RPC=${RPC})`);
    const dry = start("keeper dry run", "pnpm", ["--filter", "@callhouse/keeper", "dryrun"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DRYRUN_RPC: RPC, DRYRUN_OUT: dryOut, DRYRUN_HEALTH_PORT: String(KEEPER_PORT) },
      log: join(OUT, "dryrun.log"),
      echo: (line) => line.startsWith("== ") || line.startsWith("DRY RUN"),
    });
    const code = await dry.exited;
    if (code !== 0) throw new Error(`the keeper dry run failed (exit ${code}). Last lines:\n${dry.tail.join("\n")}`);
    runPath = join(dryOut, "run.json");
  }
  const run = JSON.parse(readFileSync(runPath, "utf8")) as RunJson;
  if (run.error !== null) throw new Error(`run.json records a failed dry run: ${run.error}`);
  const vault = getAddress(run.addresses.Vault ?? "");
  const registry = getAddress(run.addresses.MockRegistry ?? "");
  const depositor = getAddress(run.actors.depositor ?? "");
  const { vaultDeployBlock, registryDeployBlock, lastBlock } = runBlocks(run);
  const head = BigInt(await rpc<string>("eth_blockNumber"));
  if (head !== lastBlock) {
    throw new Error(`the fork head is ${head} but the dry run's last transaction is in block ${lastBlock}: something else used this anvil`);
  }
  const endBlock = head;
  say(`dry run: fork block ${run.forkBlock}, vault ${vault} (block ${vaultDeployBlock}), MockRegistry ${registry} (block ${registryDeployBlock}), last block ${endBlock}`);

  /* ---- 3. the chain's own record ---- */
  const multicallCode = await rpc<string>("eth_getCode", [MULTICALL3, "latest"]);
  if (multicallCode === "0x") throw new Error(`no Multicall3 at ${MULTICALL3} on the fork; the API's live reads need it`);
  const chain: ChainFacts = await readChainFacts({ rpc: RPC, vault, depositor, startBlock: vaultDeployBlock, registryStartBlock: registryDeployBlock, endBlock });
  say(`chain: ${chain.cycles.length} cycles, ${chain.harvests.length} Harvest logs, ${chain.listings.length} listings, ${chain.queue.settled.length} queue settlement(s)`);

  /* ---- 4. the indexer ---- */
  const pgliteDir = join(OUT, "pglite");
  const ponderEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PONDER_RPC_URL_4663: RPC,
    VAULT_ADDRESS: vault,
    START_BLOCK: vaultDeployBlock.toString(),
    REGISTRY_START_BLOCK: registryDeployBlock.toString(),
    END_BLOCK: endBlock.toString(),
    // Every address the dry run used, from the deployed vault's own immutables, so a stray
    // indexer/.env.local (which Ponder loads) cannot point any source at a different contract.
    REGISTRY: registry,
    CLEARINGHOUSE: chain.immutables.clear,
    SEAPORT: chain.immutables.seaport,
    USDG: chain.immutables.usdg,
    ASSET: chain.immutables.asset,
    OVERCALL_FEE_RECIPIENT: chain.immutables.overcallFeeRecipient,
    MULTICALL3,
    PGLITE_DIRECTORY: pgliteDir,
    DATABASE_SCHEMA: "fork_sync",
    // Ponder reads PORT before --port, and .env.example (copied to .env.local) sets it.
    PORT: String(API_PORT),
    KEEPER_HMAC_SECRET: "",
    LIVE_READ_TIMEOUT_MS: "8000",
  };
  delete ponderEnv.VAULT;
  delete ponderEnv.DATABASE_URL;
  delete ponderEnv.DATABASE_PRIVATE_URL;

  const apiInUse = await fetch(`${API}/health`).then(() => true, () => false);
  if (apiInUse) throw new Error(`port ${API_PORT} is already serving HTTP; set FORK_SYNC_API_PORT`);
  say(`ponder start: START_BLOCK=${vaultDeployBlock} END_BLOCK=${endBlock} REGISTRY_START_BLOCK=${registryDeployBlock}, PGlite at ${pgliteDir}, API ${API}`);
  const syncStarted = Date.now();
  const ponder = start("ponder", join(INDEXER_DIR, "node_modules", ".bin", "ponder"), ["start", "--schema", "fork_sync", "--port", String(API_PORT), "--log-format", "json"], {
    cwd: INDEXER_DIR,
    env: ponderEnv,
    log: join(OUT, "ponder.log"),
    echo: (line) => /"level":(50|60)|"level":"(error|fatal)"/.test(line),
  });
  await waitFor("GET /ready = 200", TIMEOUT_MS, async () => ((await fetch(`${API}/ready`)).status === 200 ? true : undefined), ponder);
  const synced = await waitFor(
    `the index head to reach END_BLOCK ${endBlock}`,
    TIMEOUT_MS,
    async () => {
      const body = (await (await fetch(`${API}/v1/health`)).json()) as { indexer?: { head?: string | null } };
      const h = body.indexer?.head;
      return h !== null && h !== undefined && BigInt(h) >= endBlock ? h : undefined;
    },
    ponder,
  );
  const syncSeconds = (Date.now() - syncStarted) / 1000;
  say(`indexer synced: head ${synced} = END_BLOCK after ${syncSeconds.toFixed(1)}s`);

  /* ---- 5. the API ---- */
  const routes = routesFor(depositor);
  const responses: Record<string, Json> = {};
  const statuses: Record<string, number> = {};
  const get = async (route: string) => {
    const path = route.replace(/^GET /, "");
    const res = await fetch(`${API}${path}`);
    statuses[route] = res.status;
    responses[route] = (await res.json()) as Json;
  };
  for (const route of [routes.vault, routes.cycles, routes.cycle(1), routes.cycle(2), routes.cycle(3), routes.listings, routes.account, routes.activity, routes.activityAll, routes.health]) {
    await get(route);
  }
  {
    const res = await fetch(`${API}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: graphqlQuery(vault.toLowerCase()) }) });
    statuses[routes.graphql] = res.status;
    responses[routes.graphql] = (await res.json()) as Json;
  }
  for (const [route, body] of Object.entries(responses)) {
    writeFileSync(join(OUT, "api", `${route.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }

  /* ---- 6. compare ---- */
  const built = buildExpectations(run, chain);
  const { passed, mismatches } = compare(responses, built.expectations);
  const badStatus = Object.entries(statuses).filter(([, s]) => s !== 200);

  const result = {
    passed: mismatches.length === 0 && built.disagreements.length === 0 && badStatus.length === 0,
    forkBlock: run.forkBlock,
    anvil: clientVersion,
    vault,
    registry,
    startBlock: vaultDeployBlock.toString(),
    endBlock: endBlock.toString(),
    syncSeconds,
    assertions: built.expectations.length,
    assertionsPassed: passed,
    crossChecks: built.crossChecks,
    routes: Object.keys(responses),
    statuses,
    disagreements: built.disagreements,
    mismatches: mismatches.map((m) => ({ ...m, actual: typeof m.actual === "symbol" ? "<missing>" : m.actual })),
  };
  writeFileSync(join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (!result.passed) {
    process.stdout.write("\nFORK SYNC FAILED\n");
    if (badStatus.length > 0) process.stdout.write(`\nnon-200 responses:\n${badStatus.map(([r, s]) => `  ${r}: ${s}`).join("\n")}\n`);
    if (built.disagreements.length > 0) {
      process.stdout.write(`\nrun.json and the chain disagree (${built.disagreements.length} of ${built.crossChecks} cross-checks):\n${built.disagreements.map((d) => `  ${d}`).join("\n")}\n`);
    }
    if (mismatches.length > 0) {
      process.stdout.write(`\nAPI vs chain truth: ${mismatches.length} of ${built.expectations.length} assertions failed\n${formatMismatches(mismatches)}\n`);
    }
    process.stdout.write(`\nresponses: ${join(OUT, "api")}\nresult:    ${join(OUT, "result.json")}\n`);
    return 1;
  }

  const u = (v: bigint) => formatUnits(v, 6);
  const lines = [
    "",
    "FORK SYNC PASSED",
    `  fork       block ${run.forkBlock}, ${clientVersion}, chain ${chainId}`,
    `  vault      ${vault} (deployed block ${vaultDeployBlock}); MockRegistry ${registry}`,
    `  indexed    blocks ${vaultDeployBlock}..${endBlock} (${endBlock - vaultDeployBlock + 1n}) in ${syncSeconds.toFixed(1)}s on PGlite; /v1/health head ${synced}`,
    ...built.weeks.map(
      (w) =>
        `  cycle ${w.cycleNumber}    ${w.status.padEnd(8)} sold ${w.sold}/${w.contracts} at ${u(w.strike)}, assigned ${w.assigned}, gross ${u(w.gross)}, fee ${u(w.fee)}, premiumNet ${u(w.premiumNet)}, strikeProceeds ${u(w.strikeProceeds)}, credited ${u(w.net)}, premiumNetPerShare ${u(w.premiumNetPerShare)}`,
    ),
    ...chain.queue.settled.map((s) => `  epoch ${s.epochId}    ${formatUnits(s.shares, 18)} shares -> ${formatUnits(s.assets, 18)} NVDA + ${u(s.usdgOut)} USDG`),
    `  checked    ${passed} of ${built.expectations.length} API assertions across ${Object.keys(responses).length} routes, ${built.crossChecks} run.json/chain cross-checks`,
    `  output     ${OUT}`,
    "",
  ];
  process.stdout.write(lines.join("\n"));
  return 0;
}

main()
  .then(async (code) => {
    await stopAll();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    process.stdout.write(`\nFORK SYNC FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    await stopAll();
    process.exit(1);
  });
