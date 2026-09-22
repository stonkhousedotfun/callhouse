#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * O3-005 live-set fork: anvil --fork-url of chain 4663 at head, no fresh deploy.
 *
 *   node ops/v2/rehearse/fork-live.mjs --services cranker,indexer
 *   node ops/v2/rehearse/fork-live.mjs --check --services cranker,indexer
 *
 * Reads the 13 live addresses from the committed registry. Impersonates admin / guardian and the
 * anvil writer/holder personas. NVDA Clearinghouse.market is eth_call'd on the fork and on the
 * public RPC at the same block and must match. Services get anvil public junk keys only.
 * ~/.callhouse-keys is never read. State lives in REHEARSE_OUT (a temp dir from rehearse.sh).
 * ------------------------------------------------------------------------------------------------- */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ABI, ANVIL_MNEMONIC, INDEXER_URL, LOGS, OUT, PORTS, PUBLIC_RPC, RELAY_URL, ROOT, RPC, RehearsalError,
  accountOf, encodeFunctionData, expect, fail, getJson, impersonate, info, keyOf, now, nyTime, patchState, portFree,
  pub, read, readJson, rpc, saveState, say, setStage, startService, step, until, writeJson,
} from "./lib.mjs";
import { forkLiveRegistryArg } from "./fork-live-lib.mjs";
import { INDEXER_GENERATED, TSX_KEEPER, restoreGenerated, run } from "./stack.mjs";

/**
 * The LIVE set's registry, which is v7 and therefore NOT lib.mjs's shared `REGISTRY` (tier1.json, the v8
 * registry steps 1-5 deploy from). See FORK_LIVE_REGISTRY in fork-live-lib.mjs. `--registry` overrides.
 */
const REGISTRY = path.join(ROOT, forkLiveRegistryArg(process.argv));
import {
  assertForkOnlyEnv, crankerEnv, indexerEnv, nvdaRow, parseServices, reportShapeOk, thirteenAddresses,
} from "./fork-live-lib.mjs";

setStage("fork-live");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const SERVICES = parseServices(argValue("--services"));

async function ethCallHex(client, { to, data, block }) {
  const tag = block == null ? "latest" : (typeof block === "string" ? block : `0x${BigInt(block).toString(16)}`);
  return client.request({ method: "eth_call", params: [{ to, data }, tag] });
}

async function main() {
  const t0 = Date.now();
  if (!existsSync(REGISTRY)) fail(`missing registry ${REGISTRY}`);
  const registry = readJson(REGISTRY);
  const addresses = thirteenAddresses(registry);
  const nvda = nvdaRow(registry);
  const admin = registry.shared.admin;
  const guardian = registry.shared.guardian;
  const writer = accountOf("ada");
  const holder = accountOf("cy");
  const crankerPk = keyOf("cranker");
  assertForkOnlyEnv({ CRANKER_PK: crankerPk, V2_REGISTRY_PATH: REGISTRY, RH_RPC: RPC });

  const planned = {
    mode: "fork-live",
    services: SERVICES,
    registry: REGISTRY,
    publicRpc: PUBLIC_RPC,
    addresses,
    nvdaAsset: nvda.asset,
    impersonate: { admin, guardian, writer, holder },
    keys: { source: `anvil mnemonic index 8 (${ANVIL_MNEMONIC.split(" ").slice(0, 2).join(" ")} … junk)`, callhouseKeysRead: false },
    out: OUT,
  };

  step("preconditions");
  mkdirSync(LOGS, { recursive: true });
  if (!(await portFree(PORTS.anvil))) fail(`port ${PORTS.anvil} is busy`);
  if (SERVICES.includes("indexer") && !(await portFree(PORTS.indexer))) fail(`port ${PORTS.indexer} is busy`);
  if (SERVICES.includes("cranker") && !(await portFree(PORTS.cranker))) fail(`port ${PORTS.cranker} is busy`);

  step("anvil --fork-url of 4663 at head (--code-size-limit 98304); no dump, no detach");
  const anvilArgs = [
    "--fork-url", PUBLIC_RPC, "--chain-id", "4663", "--port", String(PORTS.anvil),
    "--code-size-limit", "98304", "--retries", "12", "--fork-retry-backoff", "1000",
    "--timeout", "60000", "--accounts", "20",
  ];
  if (process.env.REHEARSE_FORK_BLOCK) anvilArgs.push("--fork-block-number", process.env.REHEARSE_FORK_BLOCK);
  startService("anvil", "anvil", anvilArgs, { port: PORTS.anvil });
  await until("forked anvil", async () => (await rpc("eth_chainId")) === "0x1237", { timeoutMs: 180_000, intervalMs: 500, service: "anvil" });
  const nodeInfo = await rpc("anvil_nodeInfo");
  const forkBlock = Number(nodeInfo.forkConfig?.forkBlockNumber ?? (await pub.getBlockNumber()));
  const forkTs = await now();
  info(`fork block ${forkBlock} (${nyTime(forkTs)} NY) on ${RPC}`);
  saveState({
    mode: "fork-live", createdAt: new Date().toISOString(), forkBlock, forkTs, rpc: RPC, publicRpc: PUBLIC_RPC,
    registry: REGISTRY, addresses, contracts: {
      ...Object.fromEntries(Object.entries(addresses).filter(([k]) => !k.startsWith("sources."))),
      sources: {
        chainlink: addresses["sources.chainlink"],
        univ3: addresses["sources.univ3"],
        dataStreams: addresses["sources.dataStreams"],
      },
    },
    admin, guardian, nvdaAsset: nvda.asset, detached: false, checks: [],
  });

  step("impersonate admin, guardian, writer, holder (fork-only; anvil_setBalance)");
  await impersonate(admin);
  await impersonate(guardian);
  await impersonate(writer);
  await impersonate(holder);
  expect((await rpc("eth_getBalance", [admin, "latest"])) !== "0x0", `admin ${admin} funded on the fork`);
  info(`impersonated admin ${admin}, guardian ${guardian}, writer ${writer} (anvil ada), holder ${holder} (anvil cy)`);

  step("NVDA Clearinghouse.market: fork latest vs public RPC at the fork block");
  const requireViem = createRequire(path.join(ROOT, "keeper", "package.json"));
  const { createPublicClient, defineChain, http } = requireViem("viem");
  const data = encodeFunctionData({ abi: ABI.clearinghouse, functionName: "market", args: [nvda.asset] });
  const forkHex = await rpc("eth_call", [{ to: addresses.clearinghouse, data }, "latest"]);
  const mainnet = createPublicClient({
    chain: defineChain({
      id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [PUBLIC_RPC] } },
    }),
    transport: http(PUBLIC_RPC, { timeout: 60_000, retryCount: 2 }),
  });
  const mainHex = await ethCallHex(mainnet, { to: addresses.clearinghouse, data, block: forkBlock });
  expect(String(forkHex).toLowerCase() === String(mainHex).toLowerCase() && forkHex !== "0x",
    `NVDA market() identical on fork and mainnet at block ${forkBlock}`);
  const market = await read(addresses.clearinghouse, ABI.clearinghouse, "market", [nvda.asset]);
  info(`NVDA enabled=${market.enabled} mintPaused=${market.mintPaused} strikeTick=${market.strikeTick} mintFeePpm=${market.mintFeePpm}`);

  const serviceHealth = { anvil: { status: "ok", forkBlock } };

  if (SERVICES.includes("indexer")) {
    step("indexer against the live 13 addresses (V2_START_BLOCK = fork block: no historical backfill)");
    const gen = await run("fork-live-gen-v2-registry", "pnpm", ["gen:v2-registry"], {
      cwd: path.join(ROOT, "indexer"), env: { MARKETS_REGISTRY: REGISTRY },
    });
    if (gen.code !== 0) {
      restoreGenerated(INDEXER_GENERATED);
      fail(`gen:v2-registry failed (log ${gen.log})`);
    }
    const pglite = path.join(OUT, "pglite");
    const idxEnv = indexerEnv({
      rpc: RPC, addresses, startBlock: forkBlock, pglite, port: PORTS.indexer,
    });
    try {
      startService("indexer", path.join(ROOT, "indexer/node_modules/.bin/ponder"),
        ["start", "--schema", "forklive", "--port", String(PORTS.indexer)],
        { cwd: path.join(ROOT, "indexer"), port: PORTS.indexer, env: idxEnv, inheritEnv: false });
      await until("indexer /ready", async () => (await fetch(`${INDEXER_URL}/ready`)).ok, {
        service: "indexer", timeoutMs: 180_000, intervalMs: 2_000,
      });
    } finally {
      restoreGenerated(INDEXER_GENERATED);
    }
    const health = await getJson(`${INDEXER_URL}/v2/health`).catch(() => getJson(`${INDEXER_URL}/health`).catch(() => ({ status: "unknown" })));
    serviceHealth.indexer = { status: health.status ?? "ok", block: health.block ?? null, startBlock: forkBlock };
    info(`indexer up on ${INDEXER_URL} health=${JSON.stringify(health)}`);
  }

  if (SERVICES.includes("cranker")) {
    step("cranker against the fork RPC (anvil public junk key #8; no ~/.callhouse-keys)");
    mkdirSync(path.join(OUT, "db"), { recursive: true });
    const secrets = { relayToken: randomBytes(32).toString("hex") };
    const TSX_RELAY = path.join(ROOT, "relay", "node_modules", ".bin", "tsx");
    if (existsSync(path.join(ROOT, "ops/v2/rehearse/fake-telegram.mjs")) && existsSync(TSX_RELAY)) {
      startService("telegram", process.execPath, [path.join(ROOT, "ops/v2/rehearse/fake-telegram.mjs"), String(PORTS.telegram), path.join(LOGS, "telegram.ndjson")], { port: PORTS.telegram });
      await until("Telegram stand-in", async () => (await fetch(`http://127.0.0.1:${PORTS.telegram}/health`)).ok, { service: "telegram", timeoutMs: 20_000 });
      startService("relay", TSX_RELAY, ["src/index.ts"], {
        cwd: path.join(ROOT, "relay"), port: PORTS.relay, inheritEnv: false,
        env: {
          PATH: process.env.PATH, PORT: String(PORTS.relay), RELAY_TOKEN: secrets.relayToken,
          TELEGRAM_BOT_TOKEN: "4663001:fork-live-relay-bot-token", TELEGRAM_CHAT_ID: "-1004663",
          TELEGRAM_API_BASE: `http://127.0.0.1:${PORTS.telegram}`,
        },
      });
      await until("relay /health", async () => (await fetch(`${RELAY_URL}/health`)).ok, { service: "relay", timeoutMs: 60_000 });
    }
    const env = crankerEnv({
      rpc: RPC, registryPath: REGISTRY, db: path.join(OUT, "db", "cranker.db"), port: PORTS.cranker,
      pk: crankerPk, indexerUrl: SERVICES.includes("indexer") ? INDEXER_URL : undefined,
      alertWebhook: `${RELAY_URL}/alert`, alertToken: secrets.relayToken,
    });
    startService("cranker", TSX_KEEPER, ["src/index.ts"], {
      cwd: path.join(ROOT, "keeper"), port: PORTS.cranker, env, inheritEnv: false,
    });
    const h = await until("cranker /health", async () => {
      const r = await getJson(`http://127.0.0.1:${PORTS.cranker}/health`);
      return r.status !== "starting" ? r : null;
    }, { service: "cranker", timeoutMs: 240_000, intervalMs: 1_000 });
    expect(h.status === "ok", `cranker /health ${h.status} (signer ${accountOf("cranker")})`);
    serviceHealth.cranker = { status: h.status, signer: accountOf("cranker") };
  }

  const unused = SERVICES.filter((s) => !["cranker", "indexer"].includes(s));
  if (unused.length) info(`not started in this acceptance slice: ${unused.join(", ")} (named, not implemented as a required boot)`);

  const report = {
    mode: "fork-live",
    forkBlock,
    forkTs,
    rpc: RPC,
    publicRpc: PUBLIC_RPC,
    addresses,
    impersonated: { admin, guardian, writer, holder },
    nvda: {
      asset: nvda.asset,
      identical: true,
      marketCall: { fork: forkHex, mainnet: mainHex },
      enabled: market.enabled,
      mintPaused: market.mintPaused,
      strikeTick: market.strikeTick.toString(),
      mintFeePpm: Number(market.mintFeePpm),
    },
    services: serviceHealth,
    keys: planned.keys,
    out: OUT,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  expect(reportShapeOk(report), "report shape");
  const reportPath = path.join(OUT, "FORK-LIVE-REPORT.json");
  writeJson(reportPath, report);
  writeFileSync(path.join(OUT, "FORK-LIVE-REPORT.md"),
    `# Live-set fork report (O3-005)\n\n- fork block **${forkBlock}** (${nyTime(forkTs)} NY)\n- RPC ${RPC} (public ${PUBLIC_RPC} read by anvil only)\n- NVDA market() identical: **yes**\n- services: ${Object.entries(serviceHealth).map(([k, v]) => `${k}=${v.status}`).join(", ")}\n- keys: anvil public junk mnemonic; \`~/.callhouse-keys\` not read\n- out: \`${OUT}\`\n`);
  patchState({ reportPath, servicesAt: await now(), forkLiveSeconds: report.seconds });
  say(`\nFORK-LIVE PASSED: block ${forkBlock}, NVDA market identical, services ${SERVICES.join(",")} (${report.seconds}s). report ${reportPath}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nFORK-LIVE FAILED: ${error instanceof RehearsalError ? error.message : (error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
