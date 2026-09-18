#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 2 of the O2-03 rehearsal: every v2 service against the detached fork, each health-checked.
 *
 *   a. market open: the rehearsal's price operator prints the session's rounds on the etched feeds, BEFORE any bot
 *      reads spot: NVDA and TSLA at 97 % of their pool's price (the pools do not move until settlement, when the feed
 *      prints the pool's price: a +3.1 % close that puts the first two daily rungs in the money and lets both sources
 *      agree), META at its real last answer (settles +3 % on Chainlink alone)
 *   b. Telegram stand-in (fake-telegram.mjs), the REAL relay (relay/src/index.ts) in front of it, Postgres for the
 *      notifier (a throwaway cluster under out/pg)
 *   c. pricing stand-in (pricing-standin.mjs: Black-Scholes at the fork oracle's spot; the real service needs Cboe)
 *   d. indexer-v2: gen:v2-registry from the rehearsal copy, `ponder start` on a fresh PGlite database; the generated
 *      registry file is restored as soon as Ponder has built (and again by stop.mjs)
 *   e. cranker, mm-bot, pricer: keeper/src/index.ts with V2_MODE, anvil public dev keys #8/#10/#9, alerts to the relay;
 *      each v2_boot alert must reach the Telegram stand-in through the relay
 *   f. notifier: real Postgres, Telegram through the stand-in, rules polling the indexer every 5 s
 *   g. web (unless --skip-web): gen:markets from the rehearsal copy, `next build`, markets.generated.ts restored,
 *      `next start` on 3190
 *
 *   node ops/v2/rehearse/2-services.mjs [--skip-web]
 * ------------------------------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ABI, INDEXER_URL, serviceExited, LOGS, NOTIFIER_URL, OUT, PORTS, PRICING_URL, RELAY_URL, ROOT, RPC, RehearsalError, TELEGRAM_URL, WEB_URL, expect, fail, getJson, info,
  loadState, now, nyTime, patchState, portFree, pub, pushRound, read, readJson, say, setStage, startService, step, until, usd, writeJson, accountOf,
} from "./lib.mjs";
import { GIT, INDEXER_GENERATED, TSX_KEEPER, WEB_GENERATED, restoreGenerated, run, startBot, startIndexer } from "./stack.mjs";

setStage("2-services");
const SKIP_WEB = process.argv.includes("--skip-web");
const TSX_RELAY = path.join(ROOT, "relay", "node_modules", ".bin", "tsx");
const TSX_NOTIFIER = path.join(ROOT, "notifier", "node_modules", ".bin", "tsx");
const telegramMessages = () => getJson(`${TELEGRAM_URL}/_control/messages`);

async function main() {
  const S = loadState();
  if (!S.detached) fail("step 1 has not passed (state.json detached is not true)");
  const C = S.contracts;
  const M = S.markets;
  // Resumable: a service already recorded and alive is kept (a re-run after a fix starts only what is missing).
  const running = (name) => serviceExited(name) === null;
  const serviceName = { indexer: "indexer", pricing: "pricing", notifier: "notifier", relay: "relay", telegram: "telegram", cranker: "cranker", mm: "mm-bot", pricer: "pricer", postgres: "postgres", web: "web" };
  for (const [name, port] of Object.entries(PORTS)) {
    if (["anvil", "cranker2"].includes(name) || (SKIP_WEB && name === "web") || running(serviceName[name])) continue;
    if (!(await portFree(port))) fail(`port ${port} (${name}) is busy`);
  }
  const secretsFile = path.join(OUT, "secrets.json");
  let secretsAll = existsSync(secretsFile) && running("relay") ? readJson(secretsFile) : null;
  if (secretsAll === null) {
    const webpush = createRequire(path.join(ROOT, "notifier", "package.json"))("web-push");
    secretsAll = { _readme: "Throwaway per-run values for the local rehearsal services (not keys of anything real).", relayToken: randomBytes(32).toString("hex"), mmKillToken: randomBytes(32).toString("hex"), notifierDataKey: randomBytes(32).toString("hex"), vapid: webpush.generateVAPIDKeys() };
    writeJson(secretsFile, secretsAll);
  }
  const secrets = secretsAll;
  const vapid = secretsAll.vapid;

  step("2a. market open: the session's rounds on the etched feeds, before any bot reads spot");
  const t = await now();
  if (S.open && running("cranker")) {
    info("market already open and the bots are running: kept");
  } else {
  const poolPrice = async (T) => {
    const [sqrtPriceX96] = await read(M[T].pool, ABI.pool, "slot0");
    const token0 = await read(M[T].pool, ABI.pool, "token0");
    const q = sqrtPriceX96 * sqrtPriceX96;
    // USDG base units per whole share (18-dp asset, 6-dp USDG)
    return token0.toLowerCase() === M[T].asset.toLowerCase() ? (10n ** 18n * q) >> 192n : (10n ** 18n << 192n) / q;
  };
  const open = {};
  for (const T of Object.keys(M)) {
    const realAnswer = BigInt(S.feedHistory[T].rounds[0].answer);
    let answer;
    let why;
    if (M[T].pool) {
      const p6 = await poolPrice(T);
      answer = (p6 * 97n) / 100n * 100n; // 6 dp -> the feed's 8 dp
      why = `97 % of the pool's ${usd(p6)}`;
      open[T] = { poolPrice6: p6.toString(), openAnswer8: answer.toString(), plan: "settles at the pool's TWAP, corroborated" };
    } else {
      answer = realAnswer;
      why = "the real last answer";
      open[T] = { openAnswer8: answer.toString(), settleAnswer8: ((answer * 103n) / 100n).toString(), plan: "settles +3 % on Chainlink alone, after the uncorroborated delay" };
    }
    await pushRound(M[T].feed, answer, t, `${T} market open at ${why}`);
    const [ok, spot] = await read(C.settlementOracle, ABI.oracle, "trySpot", [M[T].asset]);
    expect(ok && spot === answer / 100n, `${T} spot ${usd(spot)} USDG (${why})`);
  }
  patchState({ open, openedAt: t });
  }

  step("2b. Telegram stand-in, relay, Postgres");
  if (!running("telegram")) startService("telegram", process.execPath, [path.join(ROOT, "ops/v2/rehearse/fake-telegram.mjs"), String(PORTS.telegram), path.join(LOGS, "telegram.ndjson")], { port: PORTS.telegram });
  await until("Telegram stand-in /health", async () => (await getJson(`${TELEGRAM_URL}/health`)).ok, { service: "telegram", timeoutMs: 20_000 });
  if (!running("relay")) startService("relay", TSX_RELAY, ["src/index.ts"], {
    cwd: path.join(ROOT, "relay"), port: PORTS.relay, inheritEnv: false,
    env: { PORT: String(PORTS.relay), RELAY_TOKEN: secrets.relayToken, TELEGRAM_BOT_TOKEN: "4663001:rehearsal-relay-bot-token", TELEGRAM_CHAT_ID: "-1004663", TELEGRAM_API_BASE: TELEGRAM_URL },
  });
  await until("relay /health", async () => (await fetch(`${RELAY_URL}/health`)).ok, { service: "relay", timeoutMs: 60_000 });
  expect(true, `relay up on ${RELAY_URL}, forwarding to the Telegram stand-in`);

  const pgDir = path.join(OUT, "pg");
  if (!running("postgres")) {
    rmSync(pgDir, { recursive: true, force: true });
    const init = await run("postgres-initdb", "initdb", ["-D", pgDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    if (init.code !== 0) fail(`initdb failed (log ${init.log})`);
    // Everything here speaks TCP on 127.0.0.1, and a Unix socket under out/ can pass the 103-byte sun_path limit
    // (a checkout path of ~60 characters is enough), so the cluster serves no Unix socket at all.
    startService("postgres", "postgres", ["-D", pgDir, "-p", String(PORTS.postgres), "-c", "unix_socket_directories=", "-h", "127.0.0.1"], { port: PORTS.postgres });
  }
  await until("postgres accepts connections", async () => (await run("postgres-ready", "pg_isready", ["-h", "127.0.0.1", "-p", String(PORTS.postgres)])).code === 0, { service: "postgres", timeoutMs: 60_000 });
  expect(true, `Postgres ${execFileSync("postgres", ["--version"]).toString().trim()} on 127.0.0.1:${PORTS.postgres} (throwaway cluster)`);

  step("2c. pricing stand-in");
  if (!running("pricing")) startService("pricing", TSX_KEEPER, [path.join(ROOT, "ops/v2/rehearse/pricing-standin.mjs")], { cwd: path.join(ROOT, "keeper"), port: PORTS.pricing, env: { PORT: String(PORTS.pricing), RH_RPC: RPC, V2_REGISTRY_PATH: S.registryCopy } });
  await until("pricing stand-in /health", async () => (await getJson(`${PRICING_URL}/health`)).status === "ok", { service: "pricing", timeoutMs: 60_000 });
  const probeExpiry = Number(await read(C.expiryCalendar, ABI.calendar, "nextExpiry", [BigInt(t + 3600), false]));
  const fairProbe = await getJson(`${PRICING_URL}/fair?ticker=NVDA&strike=${(BigInt(loadState().open.NVDA.openAnswer8) / 100n / 2_500_000n + 1n) * 2_500_000n}&expiry=${probeExpiry}&type=call`);
  expect(fairProbe.fair !== null && BigInt(fairProbe.fair.raw) > 0n, `pricing stand-in /fair NVDA ~ATM call ${nyTime(probeExpiry)}: ${fairProbe.fair?.formatted} USDG (source ${fairProbe.source})`);

  step("2d. indexer-v2 (Ponder) on the fork");
  if (!running("indexer")) await startIndexer(S, { fresh: true });
  const head = await pub.getBlockNumber();
  const health = await until("indexer /v2/health near the head", async () => {
    const h = await getJson(`${INDEXER_URL}/v2/health`);
    return BigInt(h.block) + 10n >= head ? h : null;
  }, { service: "indexer", timeoutMs: 180_000 });
  expect(Number(health.interfaceVersion) === 7, `indexer /v2/health ${health.status} at block ${health.block} (head ${head}), interfaceVersion ${health.interfaceVersion}`);
  const config = await getJson(`${INDEXER_URL}/v2/config`);
  const cfgText = JSON.stringify(config).toLowerCase();
  expect([C.clearinghouse, C.orderBook, C.settlementOracle, C.autoRoller].every((a) => cfgText.includes(a.toLowerCase())), "indexer /v2/config names the rehearsal's Clearinghouse, OrderBook, SettlementOracle and AutoRoller");
  const mk = await getJson(`${INDEXER_URL}/v2/markets`);
  const listed = (Array.isArray(mk) ? mk : mk.items ?? []).map((m) => m.ticker);
  expect(["NVDA", "TSLA", "META"].every((T) => listed.includes(T)), `indexer /v2/markets lists ${listed.join(", ")}`);
  expect(execFileSync(GIT, ["-C", ROOT, "status", "--porcelain", "--", INDEXER_GENERATED]).toString().trim() === "", `${INDEXER_GENERATED} restored after Ponder built`);

  step("2e. cranker, mm-bot, pricer (keeper/src/index.ts, V2_MODE)");
  mkdirSync(path.join(OUT, "db"), { recursive: true });
  const bots = [
    ["cranker", "cranker", PORTS.cranker, "cranker"],
    ["mm-bot", "mm", PORTS.mm, "mmQuoter"],
    ["pricer", "pricer", PORTS.pricer, "pricer"],
  ];
  for (const [name, mode, port, keyRole] of bots) {
    const h = running(name)
      ? await getJson(`http://127.0.0.1:${port}/health`)
      : (await startBot(S, secrets, { name, mode, port, keyRole, db: path.join(OUT, "db", `${mode}.db`) })).health;
    expect(h.status === "ok", `${name} /health ${h.status} (signer ${accountOf(keyRole)})`);
  }
  const boots = await until("three v2_boot alerts through the relay", async () => {
    const msgs = (await telegramMessages()).filter((m) => m.bot === "4663001" && /v2_boot/.test(m.text));
    return msgs.length >= 3 ? msgs : null;
  }, { timeoutMs: 60_000 });
  expect(["cranker", "mm", "pricer"].every((mode) => boots.some((m) => m.text.includes(`${mode} online`))), `relay forwarded v2_boot for cranker, mm and pricer to the Telegram stand-in (${boots.length} messages)`);

  step("2f. notifier (Postgres, Telegram stand-in, rules over the indexer)");
  const notifierEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: `postgres://postgres@127.0.0.1:${PORTS.postgres}/postgres`, INDEXER_URL, RH_RPC: RPC,
    NOTIFIER_DATA_KEY: secrets.notifierDataKey, TELEGRAM_BOT_TOKEN: "4663002:rehearsal-notifier-bot-token", TELEGRAM_API_BASE: TELEGRAM_URL,
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:rehearsal@localhost", APP_URL: WEB_URL, PORT: String(PORTS.notifier), RULES_POLL_S: "5",
  };
  if (!running("notifier")) startService("notifier", TSX_NOTIFIER, ["src/index.ts"], { cwd: path.join(ROOT, "notifier"), port: PORTS.notifier, env: notifierEnv, inheritEnv: false });
  const nh = await until("notifier /health with the bot and the rules engine ok", async () => {
    const h = await getJson(`${NOTIFIER_URL}/health`);
    return h.database === "ok" && h.telegramBot === "ok" && h.rules?.status === "ok" ? h : null;
  }, { service: "notifier", timeoutMs: 120_000, intervalMs: 2_000 });
  expect(nh.status === "ok", `notifier /health ${nh.status}: database ${nh.database}, telegram bot ${nh.telegramBot}, rules ${nh.rules.status}`);

  if (SKIP_WEB) {
    info("web: skipped (--skip-web)");
  } else {
    step("2g. web: gen:markets from the rehearsal copy, next build, next start on 3190");
    const webEnv = {
      NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_API_URL: INDEXER_URL, NEXT_PUBLIC_NOTIFIER_URL: NOTIFIER_URL, NEXT_PUBLIC_RPC_URL: RPC, NEXT_PUBLIC_RPC_URL_2: RPC,
      NEXT_PUBLIC_CHAIN_ID: "4663", NEXT_PUBLIC_APP_URL: WEB_URL, NEXT_PUBLIC_SITE_URL: WEB_URL, MARKETS_REGISTRY: S.registryCopy, NEXT_TELEMETRY_DISABLED: "1",
    };
    if (!running("web")) {
    try {
      const g = await run("web-gen-markets", "pnpm", ["gen:markets"], { cwd: path.join(ROOT, "web"), env: webEnv });
      if (g.code !== 0) fail(`web gen:markets failed (log ${g.log})`);
      const b = await run("web-build", "pnpm", ["build"], { cwd: path.join(ROOT, "web"), env: webEnv });
      if (b.code !== 0) fail(`next build failed (log ${b.log})`);
    } finally {
      restoreGenerated(WEB_GENERATED);
    }
    expect(execFileSync(GIT, ["-C", ROOT, "status", "--porcelain", "--", WEB_GENERATED]).toString().trim() === "", `${WEB_GENERATED} restored after the build`);
    startService("web", path.join(ROOT, "web/node_modules/.bin/next"), ["start", "-p", String(PORTS.web), "-H", "127.0.0.1"], { cwd: path.join(ROOT, "web"), port: PORTS.web, env: webEnv });
    }
    await until("web / 200", async () => (await fetch(WEB_URL)).ok, { service: "web", timeoutMs: 180_000, intervalMs: 2_000 });
    const page = await (await fetch(`${WEB_URL}/nvda`)).text();
    expect(page.length > 0, `web up on ${WEB_URL} (built against the rehearsal registry copy)`);
  }
  patchState({ services: { indexer: INDEXER_URL, pricing: PRICING_URL, relay: RELAY_URL, telegram: TELEGRAM_URL, notifier: NOTIFIER_URL, web: SKIP_WEB ? null : WEB_URL }, skipWeb: SKIP_WEB, servicesAt: await now() });
  say(`\nSTEP 2 PASSED: telegram stand-in, relay, postgres, pricing stand-in, indexer, cranker, mm-bot, pricer, notifier${SKIP_WEB ? "" : ", web"} healthy against ${RPC}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nSTEP 2 FAILED: ${error instanceof RehearsalError ? error.message : (error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
