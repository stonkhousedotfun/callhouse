#!/usr/bin/env bash
':' //; exec "$(command -v node)" "$0" "$@"
'use strict';
/* -------------------------------------------------------------------------------------------------
 * ops/keeper-env.sh — one keeper environment file per registry market.
 *
 * Renders ops/keeper/markets/<TICKER>.env for every market in ops/markets/tier1.json whose status
 * is `live`, `planned` or `superseded-by-v2` (see below), from the registry alone: the factory, the
 * asset, the feed, the pricing mode and knobs, the shared protocol addresses. The keeper (keeper/src/config.ts) reads exactly
 * these keys; ops/keeper-railway.sh sets them on the Railway service `keeper-<ticker>` and layers
 * KEEPER_PK on top from ~/.callhouse-keys/markets/<TICKER>.env at deploy time. NO KEY IS EVER
 * WRITTEN HERE: these files are committed, the keys are not.
 *
 *   ops/keeper-env.sh                     # render every live/planned/superseded market
 *   ops/keeper-env.sh --tickers TSLA,AAPL # only these
 *   ops/keeper-env.sh --check             # CI / pre-deploy: exit 1 if any committed file differs
 *                                         # from what the registry renders now (or is missing/stale)
 *   ops/keeper-env.sh --registry R --out D # render another registry file (a rehearsal copy) into D
 *
 * The file is bash AND node: the second line hands a shell straight to node, so `bash
 * ops/keeper-env.sh`, `./ops/keeper-env.sh` and `node ops/keeper-env.sh` all run the same
 * program. No npm dependencies; Node 22+.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - VAULT. The pooled cNVDA vault is closed; its keeper (Railway service `keeper`) runs with
 *     VAULT + WIND_DOWN=1 and is a separate process from every factory keeper, NVDA's included.
 *     A file here never sets VAULT, so a factory keeper can never enter the pooled roll.
 *   - KEEPER_PK. See above.
 *   - SOLO_WIND_DOWN, unless the market's hand-maintained `v1RunOff` is true (ADR-10: the owner has
 *     frozen that v1 factory and its keeper only settles). Absent or false writes no line at all,
 *     so a registry without the flag renders byte-identical files.
 *   - Anything a hand edit would drift from the registry. Change tier1.json (or the keeper's own
 *     defaults) and re-run; `--check` is what keeps the two honest.
 *
 * The header of each file carries the registry's generatedAt and verifiedAtBlock (part of the
 * `--check` comparison) and the render time (not part of it), so a re-render with an unchanged
 * registry is a no-op diff.
 * ------------------------------------------------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');

const HERE = path.dirname(fs.realpathSync(__filename));
const REGISTRY = path.join(HERE, 'markets', 'tier1.json');
const OUT_DIR = path.join(HERE, 'keeper', 'markets');

/** Chain-wide defaults the keeper also compiles in (keeper/src/config.ts); written out so the file
 *  is the whole environment, readable without the source. */
const RPC_PRIMARY = 'https://rpc.mainnet.chain.robinhood.com';
const RPC_BACKUP = 'https://robinhood-rpc.publicnode.com';
const RELAY_URL = 'http://relay.railway.internal:8080/alert';
const POLL_INTERVAL_MS = 60000;
const PORT = 8787;

/* ---------------------------------------------------------------------------------------------- */
/*  arguments                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
let check = false;
let tickers = null;
let outDir = OUT_DIR;
let registryFile = REGISTRY;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--check') check = true;
  else if (a === '--tickers' || a === '-t') {
    const v = argv[++i];
    if (!v) die('--tickers needs a comma-separated list');
    tickers = new Set(v.split(/[,\s]+/).filter(Boolean).map((t) => t.toUpperCase()));
  } else if (a.startsWith('--tickers=')) {
    tickers = new Set(a.slice('--tickers='.length).split(/[,\s]+/).filter(Boolean).map((t) => t.toUpperCase()));
  } else if (a === '--out') {
    outDir = path.resolve(argv[++i] || die('--out needs a directory'));
  } else if (a === '--registry') {
    registryFile = path.resolve(argv[++i] || die('--registry needs a file'));
  } else if (a === '-h' || a === '--help') {
    usage();
    process.exit(0);
  } else die(`unknown argument: ${a}`);
}

function usage() {
  process.stdout.write(
    'usage: ops/keeper-env.sh [--tickers TSLA,AAPL] [--check] [--out DIR] [--registry FILE]\n' +
      '  renders ops/keeper/markets/<TICKER>.env for every live/planned/superseded-by-v2 market in ops/markets/tier1.json\n' +
      '  --check      render in memory and exit 1 if any committed file is missing, stale or different\n' +
      '  --registry   read this registry file instead of ops/markets/tier1.json (rehearsals, tests)\n',
  );
}

function die(message) {
  process.stderr.write(`keeper-env: ${message}\n`);
  process.exit(2);
}

/* ---------------------------------------------------------------------------------------------- */
/*  rendering                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
const shared = registry.shared;
for (const key of ['usdg', 'clearinghouse', 'seaport']) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(shared[key] || '')) die(`registry shared.${key} is not an address`);
}

/** The markets a keeper file exists for, in registry order: live, planned and superseded-by-v2.
 *  `paused` and anything else is not rendered, so a paused market's file disappears and --check
 *  flags it as stale.
 *
 *  SUPERSEDED ROWS STILL RENDER, AND RENDER EXACTLY AS THEY DID WHILE PLANNED. ADR-02 cancelled the
 *  per-market factory rollout before any of those 34 factories existed, so each file was, and stays,
 *  the no-factory environment: FACTORY blank, and a keeper booted on it exits 1, which is the right
 *  answer forever now (ops/keeper-railway.sh refuses it too). Keeping the files byte-identical keeps
 *  --check meaningful across the status flip and keeps working what reads a no-factory market's
 *  file (keeper `solo:quote --factory none`, the run-off tests). Deleting them would buy nothing
 *  and break both. The header's status word is therefore the v1 keeper state the file describes,
 *  `planned` (no factory yet), not the registry's word; the registry row is the record that the
 *  rollout was superseded. */
const RENDERED_STATUSES = ['live', 'planned', 'superseded-by-v2'];
const markets = registry.markets.filter((m) => RENDERED_STATUSES.includes(m.status));
const selected = tickers ? markets.filter((m) => tickers.has(m.ticker)) : markets;
if (tickers) {
  for (const t of tickers) if (!markets.some((m) => m.ticker === t)) die(`${t} is not a live, planned or superseded-by-v2 market in the registry`);
}
const keeperStatus = (m) => (m.status === 'superseded-by-v2' ? 'planned' : m.status);

const RENDERED_PREFIX = '# rendered ';

/** The hand-maintained run-off flag: true, false or absent (false). Anything else is refused, and so
 *  is true on a market with no factory, which has no v1 accounts to run off. */
function runOff(m) {
  if (m.v1RunOff === undefined || m.v1RunOff === false) return false;
  if (m.v1RunOff !== true) die(`${m.ticker}: registry field v1RunOff must be true or false, not ${JSON.stringify(m.v1RunOff)}`);
  if (!m.deployment?.factory) die(`${m.ticker}: v1RunOff is true but deployment.factory is null: there is no v1 factory to run off`);
  return true;
}

function render(m, renderedAt) {
  const d = m.deployment || {};
  const isVol = m.mode === 'vol';
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'none');
  const num = (v, name) => {
    if (v === null || v === undefined || v === '') die(`${m.ticker}: registry field ${name} is empty`);
    return String(v);
  };
  const lines = [];
  lines.push(`# ops/keeper/markets/${m.ticker}.env — the ${m.ticker} factory keeper's environment.`);
  lines.push(`# GENERATED by ops/keeper-env.sh from ops/markets/tier1.json (registry generatedAt ${registry.generatedAt},`);
  lines.push(`# verifiedAtBlock ${registry.verifiedAtBlock}). Do not edit by hand: change the registry and re-run.`);
  lines.push(`${RENDERED_PREFIX}${renderedAt}`);
  lines.push(`# status ${keeperStatus(m)}, wave ${m.wave}, mode ${m.mode}${m.modeReason ? ` (${m.modeReason})` : ''}.`);
  lines.push(`# keeper ${d.keeper || 'unassigned'} (ops mnemonic index ${d.keeperKeyIndex ?? '?'}); KEEPER_PK is NOT here: it is layered on`);
  lines.push(`# at deploy time from ~/.callhouse-keys/markets/${m.ticker}.env (ops/keeper-railway.sh). VAULT is never set:`);
  lines.push('# the pooled vault is closed and its keeper runs WIND_DOWN as its own service.');
  lines.push('');
  lines.push('# ---- the market ----');
  lines.push(`KEEPER_MARKET=${m.ticker}`);
  if (d.factory) {
    lines.push(`# AccountFactory, deployed block ${d.deployBlock ?? '?'} (${d.deployTx || 'tx unknown'}), implementation ${short(d.implementation)}.`);
    lines.push(`FACTORY=${d.factory}`);
  } else {
    lines.push('# Planned: no factory yet. contracts/script/DeploySoloBatch.sh writes deployment.factory into the');
    lines.push('# registry; re-run ops/keeper-env.sh afterwards. A keeper booted on this file exits 1 with');
    lines.push('# "VAULT / FACTORY: at least one must be set", which is the correct answer until then.');
    lines.push('FACTORY=');
  }
  lines.push(`# ${m.name || `${m.ticker} Stock Token`} (${m.verification?.tokenDecimals ?? 18} dp); cross-checked against factory.asset() at boot.`);
  lines.push(`ASSET=${m.asset}`);
  lines.push(`# Chainlink proxy "${m.feedDescription || m.feedName || ''}" (${m.verification?.feedDecimals ?? 8} dp); cross-checked against factory.priceFeed() at boot.`);
  lines.push(`PRICE_FEED=${m.feed}`);
  lines.push('');
  if (runOff(m)) {
    lines.push('# ---- v1 run-off (registry v1RunOff) ----');
    lines.push('# The factory is frozen (writesHalted, depositCap 0): never setWeek or listFor. Expired accounts');
    lines.push('# are still settled, and v1_drained is alerted once when no account is live or pending.');
    lines.push('SOLO_WIND_DOWN=1');
    lines.push('');
  }
  lines.push('# ---- shared protocol (registry.shared) ----');
  lines.push('# Our own Clear, not Overcall\'s: the factory was constructed against it (factory.clear() is cross-checked).');
  lines.push(`CLEARINGHOUSE=${shared.clearinghouse}`);
  lines.push(`USDG=${shared.usdg}`);
  lines.push(`SEAPORT=${shared.seaport}`);
  lines.push('');
  lines.push('# ---- pricing (keeper/README.md → Environment) ----');
  lines.push(`KEEPER_PRICING_MODE=${m.mode}`);
  if (isVol) {
    lines.push(`# Cboe's delayed chain for ${m.cboe.root}: ${m.cboe.rows ?? '?'} rows, weekly expiries, spot divergence ${m.cboe.spotDivergenceBps ?? '?'} bps at the registry build.`);
    lines.push(`KEEPER_VOL_URL=${m.cboe.url}`);
    lines.push(`KEEPER_VOL_ROOT=${m.cboe.root}`);
  } else {
    lines.push(`# fixed mode: no Cboe fetch. KEEPER_VOL_URL / KEEPER_VOL_ROOT deliberately absent (${m.modeReason || 'no usable chain'}).`);
  }
  lines.push('# fixed mode: strike = spot + this, rounded down to a whole USDG, inside the factory band.');
  lines.push(`KEEPER_STRIKE_OTM_BPS=${num(m.strikeOtmBps, 'strikeOtmBps')}`);
  lines.push('# The ask is never below this many USDG base units (registry minAskUsdg6); the config default is 1 USDG.');
  lines.push(`KEEPER_MIN_ASK_USDG6=${num(m.minAskUsdg6, 'minAskUsdg6')}`);
  lines.push(`KEEPER_TARGET_DELTA=${num(m.targetDelta, 'targetDelta')}`);
  lines.push(`KEEPER_PRICE_EDGE_BPS=${num(m.priceEdgeBps, 'priceEdgeBps')}`);
  lines.push(`KEEPER_PREMIUM_MARGIN_BPS=${num(m.premiumMarginBps, 'premiumMarginBps')}`);
  lines.push('');
  lines.push('# ---- process ----');
  lines.push(`# One SQLite file per market on the service's /data volume; never share a volume between two keepers.`);
  lines.push(`KEEPER_DB_PATH=/data/keeper-${m.ticker.toLowerCase()}.db`);
  lines.push(`KEEPER_PORT=${PORT}`);
  lines.push(`PORT=${PORT}`);
  lines.push(`RH_RPC=${RPC_PRIMARY}`);
  lines.push(`RH_RPC_2=${RPC_BACKUP}`);
  lines.push(`POLL_INTERVAL_MS=${POLL_INTERVAL_MS}`);
  lines.push('# The relay over Railway\'s private network; ALERT_WEBHOOK_TOKEN is ${{relay.RELAY_TOKEN}} on the service.');
  lines.push(`ALERT_WEBHOOK=${RELAY_URL}`);
  return `${lines.join('\n')}\n`;
}

/** Everything but the render-time line, for the comparison. */
function stable(text) {
  return text
    .split('\n')
    .filter((l) => !l.startsWith(RENDERED_PREFIX))
    .join('\n');
}

/* ---------------------------------------------------------------------------------------------- */
/*  main                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const renderedAt = new Date().toISOString();
const wanted = new Map(selected.map((m) => [m.ticker, render(m, renderedAt)]));

if (check) {
  const problems = [];
  for (const [ticker, text] of wanted) {
    const file = path.join(outDir, `${ticker}.env`);
    if (!fs.existsSync(file)) {
      problems.push(`${ticker}: ${path.relative(process.cwd(), file)} is missing`);
      continue;
    }
    const committed = fs.readFileSync(file, 'utf8');
    if (stable(committed) !== stable(text)) {
      const a = stable(committed).split('\n');
      const b = stable(text).split('\n');
      let first = 0;
      while (first < a.length && first < b.length && a[first] === b[first]) first += 1;
      problems.push(`${ticker}: differs at line ${first + 1}: committed "${a[first] ?? '(end)'}" vs registry "${b[first] ?? '(end)'}"`);
    }
  }
  if (!tickers && fs.existsSync(outDir)) {
    for (const name of fs.readdirSync(outDir)) {
      if (!name.endsWith('.env')) continue;
      const ticker = name.slice(0, -4);
      if (!wanted.has(ticker)) problems.push(`${ticker}: ${name} exists but ${ticker} is not a live, planned or superseded-by-v2 market (stale; delete it)`);
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`keeper-env --check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}\nRe-run ops/keeper-env.sh and commit the result.\n`);
    process.exit(1);
  }
  process.stdout.write(`keeper-env --check: ${wanted.size} file(s) match the registry (generatedAt ${registry.generatedAt}, block ${registry.verifiedAtBlock})\n`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
let written = 0;
let unchanged = 0;
for (const [ticker, text] of wanted) {
  const file = path.join(outDir, `${ticker}.env`);
  // An unchanged file keeps its old render-time line, so `git status` stays quiet on a no-op.
  if (fs.existsSync(file) && stable(fs.readFileSync(file, 'utf8')) === stable(text)) {
    unchanged += 1;
    continue;
  }
  fs.writeFileSync(file, text);
  written += 1;
  const m = selected.find((x) => x.ticker === ticker);
  process.stdout.write(`${ticker.padEnd(6)} ${m.status.padEnd(8)} ${m.mode.padEnd(5)} factory ${m.deployment?.factory || 'none'}  -> ${path.relative(process.cwd(), file)}\n`);
}
process.stdout.write(`keeper-env: ${written} written, ${unchanged} unchanged, ${wanted.size} market(s); registry generatedAt ${registry.generatedAt}, block ${registry.verifiedAtBlock}\n`);
