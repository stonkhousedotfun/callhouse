#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 2 of the v7 rehearsal: every v2 service against the detached fork, each health-checked.
 *
 *   a. market open: the rehearsal's price operator prints the session's rounds on the etched feeds, BEFORE any bot
 *      reads spot: the dual-source market (NVDA) 280 bps under its pool's price (DUAL_OPEN_BELOW_POOL_BPS: far enough
 *      that r0 finishes in the money; 3-story.mjs's feed heartbeat, not the pool, keeps the mm-bot's spot clock fresh;
 *      the pool does not move until settlement, when the feed prints the pool's price and both sources agree), the single-source market (SPCX,
 *      its pool nulled on the rehearsal copy) at its real last answer (settles +3 % on Chainlink alone). The markets are the registry's launch set, state.roles.
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
import { MM_FAIR_SPOT_TOLERANCE_BPS } from "./keeper-defaults.mjs";
import { dualOpen } from "./launch-set.mjs";

setStage("2-services");
const SKIP_WEB = process.argv.includes("--skip-web");
const TSX_RELAY = path.join(ROOT, "relay", "node_modules", ".bin", "tsx");
const TSX_NOTIFIER = path.join(ROOT, "notifier", "node_modules", ".bin", "tsx");
const telegramMessages = () => getJson(`${TELEGRAM_URL}/_control/messages`);
/**
 * How far under its pool's price the dual-source market opens, in bps of the pool's price. 2a asserts on the
 * fork's own prices that r0's strike is under the pool's price, so the settlement close (the feed prints the pool's
 * TWAP) finishes r0 in the money. 3h guarantees payouts on r0 only.
 *
 * The open deliberately does NOT rely on the mm-bot's pool corroboration. That needs the gap, in bps of the
 * OPEN price, at most MM_FAIR_SPOT_TOLERANCE_BPS, whose shipped default is 50 (keeper/src/v2/config.ts).
 * With NVDA's daily firstOtmBps 100 and its 2.5 USDG tick no offset satisfies both bounds: the largest corroborating
 * offset is 50 bps, the smallest that leaves r0 in the money is 100 (dualOpen over 6,020,301 pool/offset cases, none
 * both). So 3-story.mjs's feed heartbeat keeps the dual market's spot clock fresh, as Chainlink's heartbeat does in
 * production, and the spot-age halt (MM_MAX_SPOT_AGE_S, 120 s) never fires. The bot runs the shipped tolerance:
 * no MM_FAIR_SPOT_TOLERANCE_BPS override in its env. On the 2026-09-23 run the spot-age halt pulled every quote two
 * minutes after the open round and step 3d timed out.
 */
const DUAL_OPEN_BELOW_POOL_BPS = 280n;

async function main() {
  const S = loadState();
  if (!S.detached) fail("step 1 has not passed (state.json detached is not true)");
  if (!S.roles || !S.launchSet) fail("state.json has no roles/launchSet: step 1 predates T-OP-247 (INTERFACE_VERSION 8); run step 1 again");
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
      const daily = readJson(S.registryCopy).v2.defaults.ladder.daily;
      const o = dualOpen({ pool6: p6, belowBps: DUAL_OPEN_BELOW_POOL_BPS, firstOtmBps: daily.firstOtmBps, strikeTick: BigInt(M[T].strikeTick), toleranceBps: MM_FAIR_SPOT_TOLERANCE_BPS });
      answer = o.spot6 * 100n; // 6 dp -> the feed's 8 dp
      why = `${DUAL_OPEN_BELOW_POOL_BPS} bps under the pool's ${usd(p6)}`;
      // r0 in the money only. The gap (o.gapBps) is outside the mm-bot's MM_FAIR_SPOT_TOLERANCE_BPS by design;
      // 3-story.mjs's feed heartbeat keeps the spot clock fresh instead (see DUAL_OPEN_BELOW_POOL_BPS).
      expect(o.r0InTheMoney, `${T} opens ${o.gapBps} bps under its pool (outside the mm-bot's ${MM_FAIR_SPOT_TOLERANCE_BPS} bps pool corroboration: 3-story's feed heartbeat keeps its spot clock fresh); r0 strike ${usd(o.r0)} < the pool's ${usd(p6)}, so the close at the pool finishes r0 in the money`);
      open[T] = { poolPrice6: p6.toString(), openAnswer8: answer.toString(), gapBps: o.gapBps.toString(), plan: "settles at the pool's TWAP, corroborated" };
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
  const D = S.roles.dual;
  const tick = BigInt(M[D].strikeTick);
  const fairProbe = await getJson(`${PRICING_URL}/fair?ticker=${D}&strike=${(BigInt(loadState().open[D].openAnswer8) / 100n / tick + 1n) * tick}&expiry=${probeExpiry}&type=call`);
  expect(fairProbe.fair !== null && BigInt(fairProbe.fair.raw) > 0n, `pricing stand-in /fair ${D} ~ATM call ${nyTime(probeExpiry)}: ${fairProbe.fair?.formatted} USDG (source ${fairProbe.source})`);

  step("2d. indexer-v2 (Ponder) on the fork");
  // The web's "Smart pricing within my limits" is offered only when the indexer's /v2/services reports the
  // pricer healthy (web/lib/v2/smartPricing.ts smartPricingOffer), and the indexer can vouch for the pricer only through
  // PRICER_READY_URL (indexer/src/api/v2/services.ts; unset answers `not_configured`, never healthy). The rehearsal
  // never set it, so 3c's writer flow found the checkbox disabled. startIndexer (stack.mjs) passes this process's
  // environment through to Ponder, so it is set here. The pricer only starts in 2e, which is fine: services.ts reads
  // the variable and fetches /ready per request, not at boot. 2e below requires the answer to be healthy.
  process.env.PRICER_READY_URL = `http://127.0.0.1:${PORTS.pricer}/ready`;
  if (!running("indexer")) await startIndexer(S, { fresh: true });
  const head = await pub.getBlockNumber();
  const health = await until("indexer /v2/health near the head", async () => {
    const h = await getJson(`${INDEXER_URL}/v2/health`);
    return BigInt(h.block) + 10n >= head ? h : null;
  }, { service: "indexer", timeoutMs: 180_000 });
  // INTERFACE_VERSION 8: the indexer is built from the rehearsal copy, which DeployV2Batch.sh only writes
  // for a v8 registry; a 7 here would mean an indexer built against another interface than the contracts it reads.
  expect(Number(health.interfaceVersion) === 8, `indexer /v2/health ${health.status} at block ${health.block} (head ${head}), interfaceVersion ${health.interfaceVersion}`);
  const config = await getJson(`${INDEXER_URL}/v2/config`);
  const cfgText = JSON.stringify(config).toLowerCase();
  expect([C.clearinghouse, C.orderBook, C.settlementOracle, C.autoRoller].every((a) => cfgText.includes(a.toLowerCase())), "indexer /v2/config names the rehearsal's Clearinghouse, OrderBook, SettlementOracle and AutoRoller");
  const mk = await getJson(`${INDEXER_URL}/v2/markets`);
  const listed = (Array.isArray(mk) ? mk : mk.items ?? []).map((m) => m.ticker);
  expect(S.launchSet.every((T) => listed.includes(T)), `indexer /v2/markets lists ${listed.join(", ")} (launch set ${S.launchSet.join(", ")})`);
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
  // What 3c's smart-pricing checkbox waits for, asserted here where a failure is cheap to read. A resumed
  // indexer from an older build has no PRICER_READY_URL and answers `not_configured`: restart it (step 2 again).
  let services = null;
  const pricerReady = await until("indexer /v2/services reports the pricer healthy", async () => {
    services = await getJson(`${INDEXER_URL}/v2/services`);
    return services?.pricer?.healthy === true ? services.pricer : null;
  }, { service: "indexer", timeoutMs: 180_000 }).catch(() => null);
  expect(pricerReady !== null, `indexer /v2/services pricer ${pricerReady ? "healthy" : `NOT healthy: ${JSON.stringify(services?.pricer ?? services)}`} (PRICER_READY_URL ${process.env.PRICER_READY_URL})`);

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
    const page = await (await fetch(`${WEB_URL}/${S.roles.dual.toLowerCase()}`)).text();
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
