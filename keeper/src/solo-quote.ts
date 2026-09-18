/**
 * solo:quote — the per-market dry run. Prints the strike, the ask and the window the factory
 * keeper WOULD set right now, from the real feed, the real factory policy (or the launch defaults
 * for a market whose factory is not deployed yet) and, in vol mode, the real Cboe chain. Sends
 * nothing, writes nothing durable, needs no KEEPER_ROLE.
 *
 *   pnpm --filter @callhouse/keeper solo:quote                       # the environment as the keeper reads it
 *   KEEPER_ENV_FILE=ops/keeper/markets/TSLA.env pnpm --filter @callhouse/keeper solo:quote --factory none
 *   KEEPER_ENV_FILE=ops/keeper/markets/NVDA.env pnpm --filter @callhouse/keeper solo:quote
 *
 * Flags:
 *   --factory none | 0x…   override FACTORY. `none`: no factory read at all; the policy is
 *                          Policy.launchDefaults (300 / 1200 / 40 bps) and maxPriceAge the
 *                          registry default (345600 s), which is what DeploySoloBatch deploys.
 *   --mode vol | fixed     override KEEPER_PRICING_MODE for this quote only.
 *   --json                 the same figures as one JSON document (bigints as strings).
 *
 * KEEPER_PK is required by config.ts for every process; this tool never signs, so when the
 * environment has none it uses the dry-run harness's throwaway key (a keccak of a label, the
 * convention of dryrun.ts). Never a real key from anywhere else. KEEPER_DB_PATH is forced to a
 * scratch file: the keeper's memory belongs to the keeper, not to a quote.
 *
 * Exit 0 with a quote or a named skip (`vol-stale` on a Sunday is a correct answer, not an error);
 * exit 1 when the chain or the feed cannot be read at all.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, isAddress, keccak256, toHex, type Address } from 'viem';

/* ---- arguments, before config.ts reads the environment ---- */
const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`${name} needs a value\n`);
    process.exit(2);
  }
  return value;
}
const factoryFlag = flag('--factory');
const modeFlag = flag('--mode');
const asJson = argv.includes('--json');
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('usage: solo:quote [--factory none|0x…] [--mode vol|fixed] [--json]\n');
  process.exit(0);
}
if (modeFlag !== undefined && modeFlag !== 'vol' && modeFlag !== 'fixed') {
  process.stderr.write(`--mode must be vol or fixed, not ${modeFlag}\n`);
  process.exit(2);
}

// dotenv (inside config.ts) does not override a variable that is already set, so the flags win.
if (factoryFlag !== undefined) {
  if (factoryFlag === 'none') {
    delete process.env.FACTORY;
    process.env.SOLO_QUOTE_NO_FACTORY = '1';
  } else if (isAddress(factoryFlag, { strict: false })) {
    process.env.FACTORY = getAddress(factoryFlag);
  } else {
    process.stderr.write(`--factory must be none or a 20-byte hex address, not ${factoryFlag}\n`);
    process.exit(2);
  }
}
if (modeFlag !== undefined) process.env.KEEPER_PRICING_MODE = modeFlag;
// config.ts requires one of VAULT / FACTORY. With --factory none there is neither, so a placeholder
// FACTORY satisfies the schema; nothing is read from it (see `noFactory` below).
const NO_FACTORY_PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';
const noFactory = process.env.SOLO_QUOTE_NO_FACTORY === '1';
if (noFactory) process.env.FACTORY = NO_FACTORY_PLACEHOLDER;
delete process.env.VAULT;
process.env.KEEPER_PK ??= keccak256(toHex('callhouse-dryrun:keeper'));
process.env.KEEPER_DB_PATH = join(mkdtempSync(join(tmpdir(), 'callhouse-solo-quote-')), 'quote.db');
process.env.KEEPER_LOG_LEVEL ??= 'warn';
delete process.env.ALERT_WEBHOOK;
delete process.env.ALERT_WEBHOOK_TOKEN;

/* ---- the production modules; config.ts validates the environment above the moment this runs ---- */
const { config } = await import('./config.js');
const { account, publicClient } = await import('./clients.js');
const { describeInstant, nextWeekWindow } = await import('./calendar.js');
const { readFeedDecimals, readFeedSpot, FeedError } = await import('./feed.js');
const { factoryAbi, fixedStrikeDown6, planSoloWeek, policyFromTuple, pricingPhrase } = await import('./solo.js');
const { formatUsdg, loadVol } = await import('./roll.js');
const { strikeBand } = await import('./policy.js');
const { clearAbi } = await import('./abi.js');
const { store } = await import('./state.js');
type PolicyParams = import('./policy.js').PolicyParams;

/** Policy.launchDefaults(): what AccountFactory's constructor installs, and the registry's
 *  maxPriceAgeS, for a factory that is not deployed yet. */
const LAUNCH_POLICY: PolicyParams = { minOtmBps: 300n, maxOtmBps: 1200n, minPremiumBps: 40n, maxUtilizationBps: 9500n, protocolFeeBps: 500n, maxContractsCap: 50n };
const LAUNCH_MAX_PRICE_AGE_S = 345_600;

const out: Record<string, unknown> = {};
const lines: string[] = [];
function say(label: string, value: unknown): void {
  lines.push(`${label.padEnd(22)} ${String(value)}`);
}
function put(key: string, value: unknown): void {
  out[key] = value;
}

async function main(): Promise<number> {
  const factory: Address | null = noFactory ? null : (config.FACTORY as Address);
  say('market', config.KEEPER_MARKET);
  say('mode', config.KEEPER_PRICING_MODE);
  say('factory', factory ?? 'none (planned market: launch defaults)');
  say('asset', config.ASSET);
  say('feed', config.PRICE_FEED);
  say('keeper (not used)', account.address);
  put('market', config.KEEPER_MARKET);
  put('mode', config.KEEPER_PRICING_MODE);
  put('factory', factory);
  put('asset', config.ASSET);
  put('feed', config.PRICE_FEED);

  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const now = Number(block.timestamp);
  say('block', `${block.number} @ ${describeInstant(now)}`);
  put('block', block.number.toString());
  put('blockTimestamp', now);

  let policy = LAUNCH_POLICY;
  let maxPriceAge = LAUNCH_MAX_PRICE_AGE_S;
  let policySource = 'Policy.launchDefaults (no factory)';
  if (factory !== null) {
    const [raw, age, onChainFeed, onChainAsset, week, keeperRole, halted] = await Promise.all([
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'policy' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'maxPriceAge' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'priceFeed' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'asset' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'week' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'KEEPER_ROLE' }),
      publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'writesHalted' }),
    ]);
    policy = policyFromTuple(raw);
    maxPriceAge = Number(age);
    policySource = `factory.policy() at ${factory}`;
    const feedOk = onChainFeed.toLowerCase() === config.PRICE_FEED.toLowerCase();
    const assetOk = onChainAsset.toLowerCase() === config.ASSET.toLowerCase();
    say('factory.priceFeed', `${onChainFeed}${feedOk ? '' : '  MISMATCH with PRICE_FEED'}`);
    say('factory.asset', `${onChainAsset}${assetOk ? '' : '  MISMATCH with ASSET'}`);
    say('factory.writesHalted', halted);
    say('factory.week', week[0] === 0 ? 'none set yet' : `#${week[0]} strike ${formatUsdg(week[1])} ask ${formatUsdg(week[4])} close ${describeInstant(Number(week[2]))} baseExpiry ${describeInstant(Number(week[3]))}`);
    const hasRole = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'hasRole', args: [keeperRole, account.address] });
    say('keeper has role', hasRole);
    put('factoryPriceFeed', onChainFeed);
    put('factoryAsset', onChainAsset);
    put('writesHalted', halted);
    put('week', { id: week[0], strikeUsdg6: week[1].toString(), exerciseTs: Number(week[2]), baseExpiryTs: Number(week[3]), askUsdg6: week[4].toString() });
    put('hasKeeperRole', hasRole);
    if (!feedOk || !assetOk) {
      lines.push('REFUSED: the factory is wired to a different feed or asset than this environment; the keeper would exit 1 at boot.');
      return 1;
    }
  }
  say('policy', `${policySource}: minOtm ${policy.minOtmBps} maxOtm ${policy.maxOtmBps} minPremium ${policy.minPremiumBps} bps; maxPriceAge ${maxPriceAge}s`);
  put('policy', { minOtmBps: policy.minOtmBps.toString(), maxOtmBps: policy.maxOtmBps.toString(), minPremiumBps: policy.minPremiumBps.toString(), source: policySource, maxPriceAgeS: maxPriceAge });

  const [feesEnabled, feeBps, decimals] = await Promise.all([
    publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feesEnabled' }),
    publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feeBps' }),
    readFeedDecimals(config.PRICE_FEED),
  ]);
  say('clear fees', `${feesEnabled ? `ON, ${feeBps} bps` : 'off'} (${config.CLEARINGHOUSE})`);
  put('clearFeesEnabled', feesEnabled);
  put('clearFeeBps', Number(feeBps));

  let spot;
  try {
    spot = await readFeedSpot(config.PRICE_FEED, maxPriceAge, now);
  } catch (error) {
    if (error instanceof FeedError) {
      say('feed', `REFUSED (${error.code}): ${error.message}`);
      say('verdict', 'SKIP stale-oracle: the accounts would refuse to list on this feed');
      put('spot', null);
      put('verdict', { ok: false, reason: 'stale-oracle', detail: { error: error.message } });
      return 0;
    }
    throw error;
  }
  say('feed round', `${spot.roundId} answer ${spot.answer} (${decimals} dp) updated ${describeInstant(spot.updatedAt)}, age ${spot.ageS}s of ${maxPriceAge}s`);
  say('spot', `${formatUsdg(spot.spotUsdg6)} USDG per lot (${spot.spotUsdg6} base units)`);
  put('spot', { spotUsdg6: spot.spotUsdg6.toString(), answer: spot.answer.toString(), decimals, roundId: spot.roundId.toString(), updatedAt: spot.updatedAt, ageS: spot.ageS });

  const band = strikeBand(spot.spotUsdg6, policy);
  say('band', `[${formatUsdg(band.lo)}, ${formatUsdg(band.hi)}] USDG`);
  put('band', { lo: band.lo.toString(), hi: band.hi.toString() });

  const window = nextWeekWindow(now, config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
  say('window', `week of ${window.friday}, close ${describeInstant(window.exerciseTs)}, base expiry ${describeInstant(window.expiryTs)}${window.skippedForLead ? ` (skipped ${window.skippedForLead} for the lead)` : ''}`);
  put('window', window);

  say('knobs', `strikeOtm ${config.KEEPER_STRIKE_OTM_BPS} bps (fixed) | delta ${config.KEEPER_TARGET_DELTA} edge ${config.KEEPER_PRICE_EDGE_BPS} bps buffer ${config.KEEPER_STRIKE_BAND_BUFFER_BPS} bps (vol) | margin ${config.KEEPER_PREMIUM_MARGIN_BPS} bps | minAsk ${formatUsdg(config.KEEPER_MIN_ASK_USDG6)} USDG`);
  if (config.KEEPER_PRICING_MODE === 'fixed') {
    say('fixed strike', `${formatUsdg(fixedStrikeDown6(spot.spotUsdg6, config.KEEPER_STRIKE_OTM_BPS))} USDG before the band check`);
  }

  let vol = null;
  if (config.KEEPER_PRICING_MODE === 'vol') {
    vol = await loadVol(window.closeDay, now);
    if (vol.chain === null) {
      say('cboe', `FETCH FAILED: ${vol.error}`);
    } else {
      const calls = vol.chain.options.filter((o) => o.type === 'C' && o.expiry === window.closeDay).length;
      say('cboe', `${config.KEEPER_VOL_URL}`);
      say('cboe file', `root ${vol.chain.root}, generated ${vol.chain.timestamp} UTC, last trade ${vol.chain.lastTradeTime} ET, share spot ${vol.chain.shareSpot}, ${vol.chain.options.length} rows (${vol.chain.skippedRows} skipped), ${calls} calls on ${window.closeDay}`);
      put('cboe', { url: config.KEEPER_VOL_URL, root: vol.chain.root, timestamp: vol.chain.timestamp, lastTradeTime: vol.chain.lastTradeTime, shareSpot: vol.chain.shareSpot, rows: vol.chain.options.length, skippedRows: vol.chain.skippedRows, callsOnCloseDay: calls });
    }
  }

  const plan = planSoloWeek({ policy, spotUsdg6: spot.spotUsdg6, feesEnabled, feeBps: Number(feeBps), vol });
  if (!plan.ok) {
    say('verdict', `SKIP ${plan.reason}`);
    for (const [k, v] of Object.entries(plan.detail)) say(`  ${k}`, v);
    put('verdict', { ok: false, reason: plan.reason, detail: plan.detail });
    return 0;
  }
  const p = plan.pricing;
  say('verdict', 'SET WEEK');
  say('  strike', `${formatUsdg(plan.strikeUsdg6)} USDG (${p.strikeOtmBps >= 0 ? '+' : ''}${p.strikeOtmBps} bps over spot${p.strikeClamped ? `, delta strike ${formatUsdg(BigInt(p.deltaStrikeUsdg6 ?? '0'))} clamped to the ${p.strikeClamped}` : ''})`);
  say('  ask', `${formatUsdg(plan.askUsdg6)} USDG per lot, from ${p.priceSource}${plan.cappedAtStrike ? ' (CAPPED at the strike)' : ''}`);
  say('  floor / margin', `${formatUsdg(BigInt(p.floorUnit6))} / ${formatUsdg(BigInt(p.marginUnit6))} USDG (fill floor for one lot, then +${p.marginBps} bps)`);
  if (p.mode === 'vol') {
    say('  fair / with edge', `${formatUsdg(BigInt(p.fairUnit6 ?? '0'))} / ${formatUsdg(BigInt(p.volUnit6 ?? '0'))} USDG (Cboe mid at the strike, then +${p.edgeBps} bps)`);
    say('  delta / iv', `${p.deltaAtStrike?.toFixed(4)} (target ${p.targetDelta}) / ${p.ivAtStrike === null ? '?' : (p.ivAtStrike * 100).toFixed(2)}%`);
    say('  expiry priced', `${p.expiry}, share spot ${p.shareSpot}, chain ${p.chainTimestamp}, last trade ${p.lastTradeTime}`);
  }
  say('  setWeek args', `(${plan.strikeUsdg6}, ${window.exerciseTs}, ${window.expiryTs}, ${plan.askUsdg6})`);
  say('  one line', pricingPhrase(p));
  put('verdict', { ok: true, strikeUsdg6: plan.strikeUsdg6.toString(), askUsdg6: plan.askUsdg6.toString(), cappedAtStrike: plan.cappedAtStrike, setWeekArgs: [plan.strikeUsdg6.toString(), window.exerciseTs, window.expiryTs, plan.askUsdg6.toString()], pricing: p });
  return 0;
}

let code: number;
try {
  code = await main();
} catch (error) {
  lines.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  put('error', error instanceof Error ? error.message : String(error));
  code = 1;
} finally {
  store.close();
}
if (asJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
else process.stdout.write(`${lines.join('\n')}\n`);
process.exit(code);
