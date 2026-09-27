/**
 * ABI conformance: every contract call the keeper, the web app and the indexer make names a function that exists on
 * the KIND of contract actually at that address, as the compiled contracts define it (ops/abis).
 *
 * WHY THIS FILE EXISTS. From 2026-09-20 the market-maker bot read `askFloor(uint256)` from
 * every vault it quoted with the MakerVault ABI, House vaults included, and HouseVault has never had that function.
 * viem's types could not see it: the ABI literal was a real, generated MakerVault ABI and `askFloor` is on it. The
 * wrong thing was the ADDRESS the call went to. Unit tests fed fake values, the failed read became a quiet halt, and
 * nothing noticed for four days. The same shape exists wherever one contract's ABI is reused for another contract,
 * so this test checks the class, not the instance:
 *
 *   1. It parses every source file (TypeScript AST, no type checker) and collects each object literal that carries a
 *      `functionName`: readContract / writeContract / simulateContract / multicall entries / encodeFunctionData.
 *   2. It resolves the `abi` it passes (a generated module, a local `parseAbi` fragment, viem's built-in) and picks
 *      the function entry by name and argument count. That entry fixes the signature the call will encode.
 *   3. It asks KIND_RULES which contract kind(s) the `address` expression can hold. A vault address in the mm-bot can
 *      be a MakerVault or a HouseVault; a price source can be any of the three source contracts.
 *   4. For every such kind, the compiled ABI in ops/abis must have a function with the same name and input types
 *      (and the same output types, when the call site decodes outputs). One missing kind is a violation.
 *
 * A call site no rule classifies is a violation too: the next mismatch will be a pair nobody has thought of, so a new
 * call site must say what its address holds before the test goes green. EXTERNAL kinds (Uniswap, Chainlink feeds,
 * Permit2, Multicall3, ERC-4626 venues) have no compiled artifact here; they are counted and listed, not checked.
 *
 * WRAPPERS. A function whose parameters include `abi` and `functionName` (web/lib/v2/tx.ts simulatedWrite, the local
 * `write` of earnTx / lendTx / zapTx, the devnet `read` helpers) erases viem's typing: `abi: Abi, functionName: string`.
 * Its CALLERS are the call sites and are checked; the literal inside it is a passthrough. The same holds for a local
 * `(functionName) => ({ abi, address, functionName })` helper. A forwarding function with no caller the scan can follow
 * (a callback, a call through another name) is a violation, so its calls cannot drop out of the check unseen.
 *
 * DELIBERATELY ABSENT: no RPC, no type checker (a full program build of web/ would take minutes), no contracts
 * build. ops/abis/v2 is the artifact the contracts repo exports (callhouse-contracts script/v2/export-abis.sh);
 * abi.test.ts already fails when a generated module drifts from it, and this test is only as current as that export.
 * Not scanned: unit tests (they feed fakes), web/tests (fork and acceptance suites fail loudly when run) and the v1
 * files in OUT_OF_SCOPE.
 *
 * THE OPS SCRIPTS. The monitor (ops/v2/monitor.mjs), the rehearsals (ops/v2/rehearse/*.mjs) and the
 * lifecycle rehearsal scripts build their ABIs at runtime: `ABI.<key>` out of an object of
 * `abiOf("<Name>")` / `A.withErrors("<Name>")` loads, or out of the monitor's `ABI_TEXT` fragments run through parseAbi.
 * A monitor read of a function the contract lacks fails only when it runs, and when that read is the check that pages,
 * nobody is paged. The same scan covers them (OPS_ROOTS), with three additions: those runtime ABI shapes resolve
 * (resolveAbiValue, ABI_LOADERS); a helper that forwards its own parameter as the function name (`ch("series", [id])`
 * over `read(C.clearinghouse, ABI.clearinghouse, fn, args)`) is followed to its callers; and the Python harnesses'
 * `cast call` / `cast send` signature strings are checked the same way (scanPython). A call site the scan cannot
 * resolve statically is not skipped: it must be listed in OPS_UNRESOLVED with the reason, and an entry nothing
 * matches any more fails too.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import * as viem from 'viem';
import { parseAbi, type AbiFunction, type AbiParameter } from 'viem';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/*//////////////////////////////////////////////////////////////
                          COMPILED KINDS
//////////////////////////////////////////////////////////////*/

/** A contract kind with a compiled ABI in ops/abis. Named after its artifact file. */
type Kind = string;

/** Kinds without a compiled artifact in this repo: counted and reported, never checked. */
const EXTERNAL = 'EXTERNAL';

function loadCompiled(): Map<Kind, AbiFunction[]> {
  const out = new Map<Kind, AbiFunction[]>();
  const add = (kind: Kind, file: string): void => {
    const raw = JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as unknown;
    const abi = (Array.isArray(raw) ? raw : (raw as { abi: unknown[] }).abi) as Array<{ type: string }>;
    out.set(kind, abi.filter((e): e is AbiFunction => e.type === 'function'));
  };
  const v2 = path.join(repoRoot, 'ops/abis/v2');
  for (const f of readdirSync(v2)) {
    if (!f.endsWith('.json') || f === 'roles.json' || f === 'V2Errors.json') continue;
    add(f.slice(0, -'.json'.length), `ops/abis/v2/${f}`);
  }
  // The two token kinds the v2 app touches: USDG (the Clearinghouse's collateral and quote asset) and a Robinhood
  // Stock Token (every underlying). Both are compiled artifacts of the deployed token contracts.
  add('USDG', 'ops/abis/USDG.json');
  add('StockToken', 'ops/abis/StockToken.json');
  return out;
}

/** Canonical type of one ABI parameter: tuples expand to `(a,b)`, arrays keep their suffix. */
function canon(p: AbiParameter): string {
  if (p.type.startsWith('tuple')) {
    const comps = (p as AbiParameter & { components?: readonly AbiParameter[] }).components ?? [];
    return `(${comps.map(canon).join(',')})${p.type.slice('tuple'.length)}`;
  }
  return p.type;
}

const sigOf = (f: AbiFunction): string => `${f.name}(${f.inputs.map(canon).join(',')})`;
const outsOf = (f: AbiFunction): string => (f.outputs ?? []).map(canon).join(',');

/*//////////////////////////////////////////////////////////////
                            KIND RULES
//////////////////////////////////////////////////////////////*/

/**
 * What an address expression holds. The FIRST rule whose `file` matches the repo-relative path, whose `address`
 * matches the normalised address text (whole string) and, when given, whose `fn` matches the function name wins.
 * `kinds` lists every contract kind that address can hold at runtime; the call must exist on each of them.
 * `why` is mandatory: a rule is a claim about runtime data, and the next reader has to be able to check it.
 */
interface KindRule {
  file: RegExp;
  address: RegExp;
  /** The enclosing function or method name (the nearest named one), for addresses that are parameters. */
  inFn?: RegExp;
  fn?: RegExp;
  kinds: readonly Kind[] | typeof EXTERNAL;
  why: string;
}

const MM_VAULTS: readonly Kind[] = ['MakerVault', 'HouseVault'];
const SOURCES: readonly Kind[] = ['ChainlinkFeedSource', 'UniV3TwapSource', 'DataStreamsSource'];
const EARN_ADAPTERS: readonly Kind[] = ['Erc4626VenueAdapter', 'StockVenueAdapter'];
const TOKENS: readonly Kind[] = ['USDG', 'StockToken'];

const MM_QUOTER = /^keeper\/src\/v2\/mm\/quoter\.ts$/;
const MM_READS = /^keeper\/src\/v2\/mm\/reads\.ts$/;
const STEPS = /^keeper\/src\/v2\/cranker\/steps\.ts$/;
const ANY = /./;
const OPS = /^ops\//;
const MONITOR = /^ops\/v2\/monitor\.mjs$/;
const FAULTS = /^ops\/rehearse-lifecycle\/monitor-faults\.mjs$/;
const MONEY = /^ops\/rehearse-lifecycle\/money\/(run|lib)\.mjs$/;
const ACTIVITY = /^ops\/rehearse-lifecycle\/indexer-web\/activity\.py$/;

export const KIND_RULES: readonly KindRule[] = [
  /*------------------ vault addresses that can hold more than one kind (the class) ------------------*/
  {
    file: MM_QUOTER,
    inFn: /callOf/,
    address: /vault/,
    fn: /redeem/,
    kinds: ['MakerVault'],
    why: 'the only redeem tx comes from VaultView.settledHeld, which the quoter sets on the treasury MakerVault alone (planner.ts:179-182, :918); a House vault has no redeem',
  },
  { file: MM_QUOTER, inFn: /callOf|addressesFor/, address: /vault/, kinds: MM_VAULTS, why: 'every vault the mm-bot quotes: the treasury MakerVault and each House vault (T-OP-715)' },
  {
    file: MM_QUOTER,
    inFn: /answersEpochEnd/,
    address: /vault/,
    kinds: ['HouseVault'],
    why: 'deliberate kind probe: a revert or empty return means "not a House vault" (quoter.ts answersEpochEnd)',
  },
  { file: MM_QUOTER, inFn: /sendEarnMove/, address: /vault/, kinds: ['EarnVault'], why: 'its one caller passes earn.vault (quoter.ts sendEarnMove)' },
  { file: MM_QUOTER, address: /makerVault/, kinds: ['MakerVault'], why: 'config.contracts.makerVault, the treasury vault' },
  {
    file: MM_READS,
    address: /a\.vault/,
    fn: /owedUsdg|pendingDepositUsdg|performanceFeeOwed|quotingPaused|pendingDepositStock|owedStock/,
    kinds: ['HouseVault'],
    why: 'read only on a House vault: readVaultState pushes them under the House branch (T-OP-791 added the brake and the stock reserve), readHouseReserve is House-only',
  },
  { file: MM_READS, address: /a\.vault|vault/, kinds: MM_VAULTS, why: 'MmAddresses.vault (and readMeasuredNotional(a.vault)): the treasury MakerVault or a House vault' },
  { file: /^keeper\/src\/v2\/mm\/house\.ts$/, address: /vault/, kinds: ['HouseVault'], why: 'a vault HouseVaultFactory.vaults() returned (house.ts chainHouseDiscovery)' },
  { file: /^keeper\/src\/v2\/mm\/devnet-mm\.ts$/, address: /vault|D\.contracts\.makerVault/, kinds: ['MakerVault'], why: 'the devnet MakerVault (devnet-mm.ts main: D.contracts.makerVault)' },
  { file: STEPS, address: /earn\.vault/, kinds: ['EarnVault'], why: 'the registry EarnVault the cranker keeps (steps.ts earn steps)' },
  { file: STEPS, inFn: /readEarnMark/, address: /vault/, kinds: ['EarnVault'], why: 'its one caller, earnQueue, passes earn.vault (steps.ts readEarnMark, T-OP-779)' },
  { file: STEPS, address: /vault/, kinds: ['HouseVault'], why: 'the House vaults HouseVaultFactory.vaults() returned (steps.ts discover / houseRoll)' },
  { file: /^indexer\/src\/api\/v2\/chain\.ts$/, inFn: /readMakerVaultState/, address: /vault/, kinds: ['MakerVault'], why: 'its one caller passes V2_MAKER_VAULT (api/v2/vault.ts)' },
  { file: /^web\/lib\/v2\/chainReads\.ts$/, inFn: /readHouseVault/, address: /vault/, kinds: ['HouseVault'], why: 'the House page passes a registry House vault' },
  { file: /^web\/lib\/v2\/chainReads\.ts$/, inFn: /readDepositRefused/, address: /vault/, kinds: ['HouseVault'], why: 'its one caller, readHouseVault, passes the House vault it reads (T-OP-887)' },
  { file: /^web\/lib\/v2\/houseGates\.ts$/, inFn: /readHouseGateState/, address: /vault/, kinds: ['HouseVault'], why: 'its one caller passes requireHouseVaultAddress(vault) (HouseVault.tsx:219, T-OP-757)' },
  { file: /^web\/lib\/v2\/chainReads\.ts$/, inFn: /readEarnVault/, address: /vault/, kinds: ['EarnVault'], why: 'the Earn page passes the registry EarnVault' },
  { file: /^web\/lib\/v2\/moneyPreviews\.ts$/, inFn: /readEarn(Deposit|Redeem|Queued)Preview/, address: /vault/, kinds: ['EarnVault'], why: 'its one caller, LendVault.tsx (the Earn page), passes the registry EarnVault (T-OP-864 previewDeposit / previewRedeem / previewQueued)' },
  { file: ANY, address: /requireHouseVaultAddress\(vault\)|market\.houseVault/, kinds: ['HouseVault'], why: 'a registry House vault address' },
  { file: /^indexer\/src\/v2\/houseVault\.ts$/, address: /event\.args\.vault|event\.log\.address|vault/, kinds: ['HouseVault'], why: 'HouseVaultFactory:VaultCreated vault, or a HouseVault event emitter' },
  {
    file: /^(indexer\/src\/(v2\/earn|v2\/earnSample|api\/v2\/earn)|keeper\/src\/v2\/earn\/(reads|venue)|web\/lib\/v2\/(earnDeferred|lendTx))\.ts$/,
    address: /vault|row\.vault|held\.vault|requireEarnVaultAddress\(\)/,
    kinds: ['EarnVault'],
    // earn/venue.ts readVenueUnpriced is passed earn.vault (cranker steps.ts) or reads.ts's vault.
    why: 'an EarnVault address (registry v2.earn or an EarnVault event emitter)',
  },
  {
    file: /^(indexer\/src\/(v2\/earnSample|api\/v2\/earn)|keeper\/src\/v2\/earn\/reads)\.ts$/,
    address: /adapter|row\.adapter|adapterAddress/,
    kinds: EARN_ADAPTERS,
    why: 'EarnVault.adapter(): an ERC-4626 venue adapter or the stock venue adapter',
  },

  /*------------------------------------------- price sources -------------------------------------------*/
  {
    file: /^keeper\/src\/v2\/guardian\/watch\.ts$/,
    inFn: /readRoundAge/,
    address: /source/,
    kinds: ['ChainlinkFeedSource'],
    why: 'deliberate kind probe: "a source without pinnedFeeds is not a ChainlinkFeedSource: the read reverts, and the answer is null" (watch.ts readRoundAge)',
  },
  {
    file: STEPS,
    inFn: /awaitingSnapshot/,
    address: /address/,
    kinds: ['UniV3TwapSource'],
    why: 'asks the dark sources for a pool snapshot; a ChainlinkFeedSource has no snapshots(), its read fails and okResult drops it (steps.ts awaitingSnapshot). DataStreamsSource is not registered at launch',
  },
  { file: ANY, address: /D\.contracts\.sources\.univ3/, kinds: ['UniV3TwapSource'], why: 'the devnet UniV3TwapSource' },
  { file: ANY, address: /source|e\.source/, kinds: SOURCES, why: 'a SettlementOracle market source: any of the three source contracts' },

  /*------------------------------------------------ tokens ------------------------------------------------*/
  { file: ANY, address: /usdg|a\.usdg|USDG/, kinds: ['USDG'], why: 'the USDG token' },
  {
    file: /^web\/components\/v2\/TradeTicket\.tsx$/,
    address: /usdgToken/,
    kinds: ['USDG'],
    why: "the wallet's USDG: config.data.usdg.address, read for the buy ticket's balance check",
  },
  {
    file: /^(indexer\/src\/api\/v2\/chain|web\/lib\/v2\/rewardPrograms)\.ts$/,
    address: /token/,
    kinds: ['USDG'],
    why: 'RewardsDistributor.usdg(): the token the distributor pays',
  },
  { file: ANY, address: /m\.underlying|underlying|stock/, kinds: ['StockToken'], why: 'a market underlying: a Robinhood Stock Token' },
  { file: /^keeper\/src\/v2\/pricing\/pool-spot\.ts$/, address: /asset/, kinds: ['StockToken'], why: 'the Stock Token of a Stock/USDG pool (pool-spot.ts header)' },
  { file: /^keeper\/src\/v2\/cranker\/flywheel\.ts$/, inFn: /stepFlywheel/, address: /a/, kinds: TOKENS, why: 'assets = [usdg, ...market underlyings] (flywheel.ts stepFlywheel)' },
  { file: ANY, address: /asset|row\.asset/, kinds: TOKENS, why: 'collateral or a vault asset: USDG or a Stock Token' },

  /*-------------------------------------------- payout router --------------------------------------------*/
  { file: /^web\/lib\/v2\/conversion\.ts$/, address: /adapter/, kinds: ['PayoutRouter'], why: 'Clearinghouse.payoutAdapter(), which is the PayoutRouter' },
  { file: /^indexer\/src\/v2\/flywheel\.ts$/, address: /event\.log\.address/, fn: /routes/, kinds: ['PayoutRouter'], why: 'a PayoutRouter event emitter' },
  { file: /^indexer\/src\/v2\/flywheel\.ts$/, address: /event\.log\.address/, fn: /treasury/, kinds: ['FeeSplitter'], why: 'a FeeSplitter event emitter' },

  /*----------------------------------------- one-kind addresses -----------------------------------------*/
  {
    file: MM_READS,
    inFn: /readMarkets/,
    address: /configs\[i\]\?\.oracle\?\?a\.clearinghouse/,
    kinds: ['SettlementOracle'],
    why: 'the market oracle; the Clearinghouse fallback only keeps the batch aligned when market() failed, and its result is discarded (spot is undefined without a config)',
  },
  {
    file: /^keeper\/src\/v2\/cranker\/(steps|devnet-cycle)\.ts$/,
    inFn: /encodeCreateSeries|create/,
    address: /<none>/,
    kinds: ['Clearinghouse'],
    why: 'calldata for Clearinghouse.createSeries, sent through Multicall3.aggregate3 with the Clearinghouse as target',
  },
  { file: ANY, address: /(?:[\w.]*\.)?clearinghouse|clearinghouse\(\)|V2_CLEARINGHOUSE|requireV2Address\("clearinghouse"\)/, kinds: ['Clearinghouse'], why: 'the Clearinghouse' },
  { file: ANY, address: /(?:[\w.]*\.)?(?:orderBook|liveOrderBook)|ob|requireV2Address\("orderBook"\)/, kinds: ['OrderBook'], why: 'the OrderBook' },
  {
    file: ANY,
    address: /(?:[\w.[\]]*\.)?(?:oracle|settlementOracle)|V2_SETTLEMENT_ORACLE|requireV2Address\("settlementOracle"\)|v2ContractAddress\("settlementOracle"\)\?\?zeroAddress|oracleOf\.get\(u\)|oracles\[i\]|address\(series\.oracle\)/,
    kinds: ['SettlementOracle'],
    // Web chainReads.readHouseVault reads SETTLEMENT_WINDOW() in its multicall from the registry's oracle, or
    // the zero address (that one call fails) when the registry names none.
    why: 'the SettlementOracle (a series pins its oracle at creation)',
  },
  { file: ANY, address: /(?:[\w.]*\.)?(?:calendar|expiryCalendar)|requireV2Address\("expiryCalendar"\)/, kinds: ['ExpiryCalendar'], why: 'the ExpiryCalendar' },
  { file: /^keeper\/src\/v2\/pricing\/coverage-main\.ts$/, inFn: /createChainNextExpiry/, address: /address/, kinds: ['ExpiryCalendar'], why: 'createChainNextExpiry(rpc, calendar address)' },
  { file: ANY, address: /(?:[\w.]*\.)?(?:roller|autoRoller)|requireV2Address\("autoRoller"\)/, kinds: ['AutoRoller'], why: 'the AutoRoller' },
  { file: ANY, address: /(?:[\w.]*\.)?(?:manager|accessManager)/, kinds: ['AccessManager'], why: 'the AccessManager' },
  { file: ANY, address: /(?:[\w.]*\.)?(?:splitter|feeSplitter)/, kinds: ['FeeSplitter'], why: 'the FeeSplitter' },
  { file: ANY, address: /distributor/, kinds: ['RewardsDistributor'], why: 'a RewardsDistributor' },
  { file: ANY, address: /requireV2Address\("stockZap"\)/, kinds: ['StockZap'], why: 'the StockZap' },
  { file: /^keeper\/src\/v2\/(cranker\/steps|mm\/house)\.ts$/, address: /f|f\.address/, kinds: ['HouseVaultFactory'], why: 'a registry HouseVaultFactory' },

  /*----------------- ops scripts: monitor, rehearsals, lifecycle rehearsals -----------------*/
  // The generic rules above already classify C.clearinghouse, C.orderBook, C.settlementOracle, C.autoRoller,
  // ctx.C.accessManager and the like. These name what the ops scripts' own spellings hold: `contracts()` (rehearse
  // drill-kit), money/run.mjs's short `C.ch` / `C.fs`, activity.py's `self.ch`, and the monitor's registry reads.
  { file: OPS, address: /(?:contracts\(\)|C|self)\.(?:clearinghouse|ch)/, kinds: ['Clearinghouse'], why: 'the registry v2.contracts.clearinghouse (rehearse contracts(), money C.ch, activity.py self.ch)' },
  { file: OPS, address: /(?:contracts\(\)|C|self)\.(?:orderBook|ob)/, kinds: ['OrderBook'], why: 'the registry v2.contracts.orderBook (rehearse contracts(), money C.ob, activity.py self.ob)' },
  { file: OPS, address: /(?:contracts\(\)|C|self)\.(?:settlementOracle|so)/, kinds: ['SettlementOracle'], why: 'the registry v2.contracts.settlementOracle (rehearse contracts(), money C.so, activity.py self.so)' },
  {
    file: MONITOR,
    address: /sr\.o|x\.o|vaultOracle/,
    kinds: ['SettlementOracle'],
    why: 'sr.o / x.o: the oracle a scanned series pinned at creation (Series.oracle); vaultOracle: HouseVault.oracle(), else C.settlementOracle',
  },
  { file: MONITOR, inFn: /simulatePin/, address: /<none>/, kinds: ['SettlementOracle'], why: 'pin() calldata sent by transportClient.call to `oracle`, the series oracle (monitor.mjs simulatePin)' },
  { file: MONITOR, inFn: /earnWithdrawableNow/, address: /reg\.earnVault/, kinds: ['EarnVault'], why: 'the registry v2.contracts.earnVault (monitor.mjs earnWithdrawableNow, T-OP-643)' },
  { file: MONITOR, inFn: /runOnce/, address: /reg\.earnVault/, kinds: ['EarnVault'], why: 'the registry v2.contracts.earnVault (monitor.mjs funding check: fundingEnabled(), T-OP-846)' },
  { file: MONITOR, inFn: /earnSkimBpsNow/, address: /reg\.earnVault/, kinds: ['EarnVault'], why: 'the registry v2.contracts.earnVault (monitor.mjs earnSkimBpsNow: skimBps() at the head, T-OP-950)' },
  {
    file: MONITOR,
    inFn: /earnWithdrawableNow/,
    address: /a\.value/,
    fn: /withdrawable/,
    kinds: EARN_ADAPTERS,
    why: 'EarnVault.adapter() read the line before (monitor.mjs earnWithdrawableNow, T-OP-643): an ERC-4626 venue adapter or the stock venue adapter',
  },
  // The AutoRoller witness path in runOnce, read the way AutoRoller._tryWitness reads it.
  {
    file: MONITOR,
    inFn: /runOnce/,
    address: /x\.p\.u/,
    kinds: ['StockToken'],
    why: 'an AutoRoller position underlying (the strategy underlying, a registry markets[].asset): a Robinhood Stock Token; _tryWitness reads its oraclePaused()',
  },
  {
    file: MONITOR,
    inFn: /runOnce/,
    address: /sources\[1\]/,
    kinds: SOURCES,
    why: "source 1 of the series oracle's settlementConfig(u, expiry), read the line before: any registered price source (AutoRoller._tryWitness calls IPriceSource(sources[1]).latest(u)); the launch markets register the UniV3TwapSource there",
  },
  { file: OPS, address: /(?:contracts\(\)|C|self)\.(?:expiryCalendar|cal)/, kinds: ['ExpiryCalendar'], why: 'the registry v2.contracts.expiryCalendar (rehearse contracts(), money C.cal, activity.py self.cal)' },
  { file: OPS, address: /(?:contracts\(\)|contracts|C|ctx\.C|reg)\.sources\.chainlink/, kinds: ['ChainlinkFeedSource'], why: 'the registry v2.contracts.sources.chainlink' },
  { file: OPS, address: /(?:contracts\(\)|contracts|C|ctx\.C|reg)\.sources\.univ3|u3/, kinds: ['UniV3TwapSource'], why: 'the registry v2.contracts.sources.univ3 (activity.py u3 is the same key)' },
  { file: OPS, address: /(?:ctx\.C|reg)\.sources\.dataStreams/, kinds: ['DataStreamsSource'], why: 'the registry v2.contracts.sources.dataStreams' },
  {
    file: MONEY,
    inFn: /poolPrice/,
    address: /src/,
    kinds: ['UniV3TwapSource'],
    why: 'deliberate kind probe: poolPrice asks every market source for pools(); only the UniV3TwapSource answers, the others revert into its catch (money/run.mjs poolPrice)',
  },
  {
    file: /^ops\/rehearse-lifecycle\/keeper-lifecycle\/drive\.mjs$/,
    inFn: /poolPrice/,
    address: /src/,
    kinds: ['UniV3TwapSource'],
    why: 'deliberate kind probe, as money/run.mjs: poolPrice asks every market source for pools(); only the UniV3TwapSource answers, the others revert into its catch (keeper-lifecycle/drive.mjs poolPrice)',
  },
  { file: /^ops\/rehearse-lifecycle\/keeper-lifecycle\/earn\.mjs$/, address: /EV/, kinds: ['EarnVault'], why: 'the registry v2.contracts.earnVault (keeper-lifecycle/earn.mjs EV)' },
  { file: /^ops\/rehearse-lifecycle\/keeper-lifecycle\/drive\.mjs$/, address: /C\.ar/, kinds: ['AutoRoller'], why: 'the registry v2.contracts.autoRoller (keeper-lifecycle/drive.mjs C.ar)' },
  // web-txs/flows.mjs, reached through ENV_OBJECTS. mk = E.M[t], built in web-txs/run.mjs world().
  {
    file: /^ops\/rehearse-lifecycle\/web-txs\/flows\.mjs$/,
    inFn: /poolTwap/,
    address: /src/,
    kinds: ['UniV3TwapSource'],
    why: 'deliberate kind probe, as money/run.mjs poolPrice: poolTwap asks every market source for pools(); only the UniV3TwapSource answers, the others throw into its catch',
  },
  { file: /^ops\/rehearse-lifecycle\/web-txs\/flows\.mjs$/, address: /mk\.houseVault/, kinds: ['HouseVault'], why: 'run.mjs world(): M[t].houseVault is the generated registry markets[].v2.houseVault' },
  { file: /^ops\/rehearse-lifecycle\/web-txs\/flows\.mjs$/, inFn: /lend/, address: /vault/, kinds: ['EarnVault'], why: 'lend(): vault = lendTx.earnVaultAddress(), the registry v2.contracts.earnVault (web/lib/v2/lendTx.ts)' },
  { file: /^ops\/rehearse-lifecycle\/web-txs\/flows\.mjs$/, address: /mk\.asset/, kinds: ['StockToken'], why: 'run.mjs world(): M[t].asset is the generated registry markets[].asset, a Robinhood Stock Token' },
  {
    file: /^ops\/rehearse-lifecycle\/weekend-drill\/drill\.mjs$/,
    inFn: /poolLeg/,
    address: /src/,
    kinds: ['UniV3TwapSource'],
    why: 'deliberate kind probe, as money/run.mjs poolPrice: poolLeg asks every market source for pools(); only the UniV3TwapSource answers, the others revert into its catch (T-OP-667)',
  },
  {
    file: /^ops\/rehearse-lifecycle\/weekend-drill\/drill\.mjs$/,
    inFn: /main/,
    address: /m\.sources\[0\]/,
    kinds: ['ChainlinkFeedSource'],
    why: 'source 0 of a launch market (SettlementOracle.marketConfig): RegisterMarkets registers want[0] = the ChainlinkFeedSource (T-OP-667 reads its DEFAULT_MAX_STALE)',
  },
  { file: OPS, address: /(?:contracts|C|ctx\.C)\.(?:keeperRewards|kr)/, kinds: ['KeeperRewards'], why: 'the registry v2.contracts.keeperRewards (money C.kr)' },
  { file: OPS, address: /(?:contracts|C|ctx\.C)\.(?:makerVault|mv)/, kinds: ['MakerVault'], why: 'the registry v2.contracts.makerVault, the treasury MakerVault (money C.mv)' },
  {
    file: MONITOR,
    address: /C\.payoutAdapter/,
    fn: /factory/,
    kinds: ['UniV3PayoutAdapter'],
    why: 'deliberate kind probe: only the v7 UniV3PayoutAdapter answers factory(); a PayoutRouter reverts, and routes() is decoded by which one answered (ABI_TEXT.payoutRouter)',
  },
  {
    file: OPS,
    address: /(?:contracts|C|ctx\.C)\.payoutAdapter|s\.router/,
    kinds: ['PayoutRouter'],
    why: 'from INTERFACE_VERSION 8 the registry key payoutAdapter names the PayoutRouter (DeployV8 "V2_ADDRESS payoutAdapter"); money s.router is FeeSplitter.router(), read with the PayoutRouter ABI',
  },
  { file: MONEY, address: /C\.fs/, kinds: ['FeeSplitter'], why: 'the registry v2.flywheel.feeSplitter (money/run.mjs C.fs)' },
  { file: OPS, address: /C\.bx|executor/, kinds: ['V4BuybackExecutor'], why: 'the registry v2.flywheel.buybackExecutor (money C.bx, monitor executor)' },
  { file: MONEY, address: /C\.mr/, kinds: ['MakerRegistry'], why: 'the registry v2.contracts.makerRegistry (money/run.mjs C.mr)' },
  { file: OPS, address: /C\.ev|self\.earn_vault/, kinds: ['EarnVault'], why: 'the registry v2.contracts.earnVault' },
  {
    file: OPS,
    address: /h\.address|HOUSE\.vault|m\.house|mkt\(ctx,"NVDA"\)\.v2\.house\.daily/,
    kinds: ['HouseVault'],
    why: 'a market House vault (registry markets[].v2.house, or the monitor --house list): monitor h.address, money HOUSE.vault / m.house, monitor-faults NVDA daily',
  },
  { file: ACTIVITY, inFn: /house|roll/, address: /v/, kinds: ['HouseVault'], why: 'activity.py house / roll: v = markets[].v2.house[kind], a House vault' },
  { file: MONITOR, address: /e\.address/, fn: /feeParams/, kinds: ['OrderBook'], why: 'the emitter of an OrderBook fee-params event: the fees in force the block before it' },
  { file: /^ops\/rehearse-lifecycle\/service-boot\/keys\.py$/, address: /am/, kinds: ['AccessManager'], why: 'keys.py grant / has_role: am is the registry v2.contracts.accessManager' },
  { file: /^ops\/v2\/rehearse\/fork-live\.mjs$/, inFn: /main/, address: /<none>/, kinds: ['Clearinghouse'], why: 'market() calldata eth_call-ed to addresses.clearinghouse (fork-live.mjs main)' },
  { file: FAULTS, inFn: /openSeries/, address: /<none>/, kinds: ['Clearinghouse'], why: 'createSeries calldata eth_call-ed to CH (monitor-faults.mjs openSeries)' },
  { file: FAULTS, inFn: /cause/, address: /<none>/, fn: /setFeeParams/, kinds: ['OrderBook'], why: 'OrderBook.setFeeParams calldata the stranger schedules on ctx.C.orderBook through the AccessManager' },
  // Tokens.
  { file: OPS, address: /(?:[\w.()]*\.)?usdg/, kinds: ['USDG'], why: 'the registry shared.usdg (monitor reg.usdg, rehearse reg.shared.usdg / S.usdg, money C.usdg, activity.py self.usdg)' },
  {
    file: OPS,
    address: /m\.asset|markets\[T\]\.asset|M\[[DX]\]\.asset|mkt\(ctx,"NVDA"\)\.asset|m\["asset"\]/,
    kinds: ['StockToken'],
    why: 'a market underlying (registry markets[].asset): a Robinhood Stock Token',
  },
  {
    file: OPS,
    address: /token|t|<none>/,
    inFn: /bal|approve|deal|findBalanceSlot|dealToken|main/,
    kinds: TOKENS,
    why: 'an ERC-20 helper (bal / approve / deal / findBalanceSlot / dealToken, and 1-fork main\'s token loops over [usdg, ...assets]): USDG or a Stock Token',
  },
  // External contracts the ops scripts touch: counted, not checked.
  {
    file: OPS,
    address: /(?:markets\(\)\[T\]|markets\[T\]|M\[T\]|M\[tk\]|m|mkt\(ctx,"NVDA"\))\.feed|feedAddress|proxy|cfg\.value\[0\]|p\.value\[0\]/,
    kinds: EXTERNAL,
    why: 'a Chainlink feed proxy (registry markets[].feed, ChainlinkFeedSource.feeds / pinnedFeeds); the rehearsals etch MockRoundFeed over it',
  },
  { file: OPS, address: /(?:markets\[T\]|M\[T\])\.pool|m\.v2\.univ3Pool|poolCfg\.value\[0\]|p\[0\]/, kinds: EXTERNAL, why: 'a Uniswap v3 pool (registry markets[].v2.univ3Pool, UniV3TwapSource.pools)' },
  { file: OPS, address: /safe|entry\.safe|e\.address|ctx\.reg\.shared\.safes\.\w+/, kinds: EXTERNAL, why: 'a Safe multisig (registry shared.safes)' },
  { file: OPS, address: /registry|reg|accessRegistry/, fn: /isBlocked/, kinds: EXTERNAL, why: "a Stock Token's ACCESS_CONTROLLED_REGISTRY" },
  { file: OPS, address: /reg\.v2\.uniswapV3\.swapRouter02/, kinds: EXTERNAL, why: 'Uniswap SwapRouter02' },
  { file: OPS, address: /RUN\.cfg\.splitter\.token/, kinds: EXTERNAL, why: 'FeeSplitter.stonkhouse(): the flywheel buyback token, an ERC-20 the owner configures' },

  /*------------------------------- external contracts: counted, not checked -------------------------------*/
  { file: ANY, address: /feed/, kinds: EXTERNAL, why: 'a Chainlink aggregator' },
  { file: ANY, address: /pool|v3PoolAddress\(.*\)/, kinds: EXTERNAL, why: 'a Uniswap v3 pool' },
  { file: ANY, address: /V2_UNISWAP_V3\.quoterV2/, kinds: EXTERNAL, why: 'Uniswap v3 QuoterV2' },
  { file: ANY, address: /"0x000000000022D473030F116dDEE9F6B43aC78BA3"/, kinds: EXTERNAL, why: 'Permit2' },
  { file: ANY, address: /"0x8876789976decbfcbbbe364623c63652db8c0904"/i, kinds: EXTERNAL, why: 'Uniswap UniversalRouter' },
  { file: ANY, address: /(?:[\w.]*\.)?multicall3/, kinds: EXTERNAL, why: 'Multicall3' },
  { file: /^indexer\/src\/v2\/earnSample\.ts$/, address: /venue/, kinds: EXTERNAL, why: 'the ERC-4626 venue behind an Earn adapter' },
  { file: ANY, address: /V2_FLYWHEEL_TOKEN_ADDRESS/, kinds: EXTERNAL, why: 'the flywheel buyback token: an ERC-20 the owner configures, no artifact here' },
];

/*//////////////////////////////////////////////////////////////
                              SCOPE
//////////////////////////////////////////////////////////////*/

/** Directories scanned, repo-relative. */
const ROOTS = ['keeper/src', 'web/lib', 'web/components', 'web/app', 'indexer/src', 'indexer/lib', 'indexer/scripts'];

/**
 * The ops scripts that load contract ABIs at runtime: a file, or a directory walked for .mjs / .js / .ts
 * (scan) and .py (scanPython).
 */
const OPS_ROOTS = ['ops/v2/monitor.mjs', 'ops/v2/rehearse', 'ops/rehearse-lifecycle'];

/** Files never scanned: unit tests feed fakes, and the ABI modules themselves carry no calls. */
const SKIP = [/\.test\.(tsx?|m?js)$/, /\.d\.ts$/, /\/fixtures\//, /^keeper\/src\/v2\/abi\//, /^web\/lib\/abi\//];

/**
 * Out of scope, each with its reason. Asserted to exist, so a rename cannot leave a stale exclusion that hides a
 * new file of the same name.
 */
const V1 =
  'v1 (Valorem-era Vault / WriterAccount / AccountFactory) path: the v9 launch is v2 contracts only and the owner has retired v1 (2026-09-24). ' +
  'Its ABIs are separate artifacts (ops/abis/*.json, keeper src/abi.ts pinned by src/abi.test.ts against contracts/out); no v2 kind is reachable from it.';
const OUT_OF_SCOPE: ReadonlyArray<{ file: string; why: string }> = [
  ...[
    'keeper/src/dryrun-common.ts',
    'keeper/src/dryrun-extended.ts',
    'keeper/src/dryrun.ts',
    'keeper/src/feed.ts',
    'keeper/src/policy.ts',
    'keeper/src/roll.ts',
    'keeper/src/seaport.ts',
    'keeper/src/solo-quote.ts',
    'keeper/src/solo.ts',
    'web/components/AccountView.tsx',
    'web/components/BookView.tsx',
    'web/components/RedeemQueue.tsx',
    'web/components/StrandedBanner.tsx',
    'web/components/UsdgClaim.tsx',
    'web/components/legacy/ExercisePanel.tsx',
    'web/components/legacy/FreezeBanner.tsx',
    'web/components/legacy/MigrationGuide.tsx',
    'web/lib/hooks.ts',
    'web/lib/keeperOrders.ts',
    'indexer/src/vault.ts',
    'indexer/src/factory.ts',
    'indexer/src/api/chain.ts',
    'indexer/scripts/fork-sync/chain.ts',
    'indexer/lib/indexing.ts',
  ].map((file) => ({ file, why: V1 })),
];

/*//////////////////////////////////////////////////////////////
                             SCANNER
//////////////////////////////////////////////////////////////*/

export interface Site {
  file: string;
  line: number;
  /** The nearest named enclosing function, method or const-bound arrow; '' at module level. */
  ctx: string;
  address: string;
  abi: string;
  fns: string[];
  arity: number | null;
  kinds: readonly Kind[] | typeof EXTERNAL | null;
  /** The KIND_RULES entry that classified the site, or null. */
  rule: KindRule | null;
  /** True once the site was checked against a compiled ABI (classified, not external, abi and function name resolved). */
  checked: boolean;
}

/**
 * A call site the scan found but could not check statically: its abi or function name is computed at runtime, or it
 * forwards to callers the scan cannot follow. Each is ALSO a violation (the keeper / web / indexer test allows none);
 * the ops test accepts one only when OPS_UNRESOLVED names it with a reason.
 */
export interface Unresolved {
  file: string;
  line: number;
  ctx: string;
  /** The violation text, as it appears in `violations`. */
  text: string;
}

export interface ScanResult {
  sites: Site[];
  violations: string[];
  unresolved: Unresolved[];
}

interface ResolvedAbi {
  label: string;
  functions: AbiFunction[];
}

type Reader = (rel: string) => string | null;

const diskReader: Reader = (rel) => {
  try {
    return readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return null;
  }
};

const parsed = new Map<string, ts.SourceFile>();
function parse(rel: string, text: string): ts.SourceFile {
  const key = `${rel}\u0000${text.length}\u0000${text.slice(0, 64)}`;
  let sf = parsed.get(key);
  if (sf === undefined) {
    const js = /\.[mc]?jsx?$/.test(rel);
    const kind = rel.endsWith('x') ? (js ? ts.ScriptKind.JSX : ts.ScriptKind.TSX) : js ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    parsed.set(key, sf);
  }
  return sf;
}

/** Peel `x as T`, `x satisfies T`, `(x)`, `x!`. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else return e;
  }
}

/** Top-level and nested `const X = ...` declarations of one file, by name (the last one wins; shadowing is rare here). */
function constsOf(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) out.set(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** `import { a as b } from 'x'`: local name → { spec, exported name }. */
function importsOf(sf: ts.SourceFile): Map<string, { spec: string; name: string }> {
  const out = new Map<string, { spec: string; name: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const b = st.importClause?.namedBindings;
    if (b === undefined || !ts.isNamedImports(b)) continue;
    for (const el of b.elements) out.set(el.name.text, { spec: st.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
  }
  return out;
}

/** Resolve an import specifier from `fromRel` to a repo-relative .ts/.tsx file, or null (a package). */
function resolveSpec(fromRel: string, spec: string, read: Reader): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.posix.join('web', spec.slice(2));
  else if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(fromRel), spec);
  else return null;
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  for (const cand of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, base]) if (read(cand) !== null) return cand;
  return null;
}

/** Evaluate a JSON-shaped literal (the generated `[...] as const` modules). Returns undefined when not a literal. */
function evalLiteral(e: ts.Expression, rel: string, read: Reader, depth = 0): unknown {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(e)) {
    const out: unknown[] = [];
    for (const el of e.elements) {
      if (ts.isSpreadElement(el)) {
        // `...abi.filter((x) => x.type === "error" ...)` (drill-kit managedExecute): errors only, no function.
        if (/^[\w.]+\.filter\(\((\w+)\)=>\1\.type==="error"/.test(el.expression.getText().replace(/\s+/g, ''))) continue;
        const inner = depth < 4 ? resolveAbiValue(el.expression, rel, read, depth + 1) : undefined;
        if (!Array.isArray(inner)) return undefined;
        out.push(...inner);
      } else {
        const v = evalLiteral(el, rel, read, depth);
        if (v === undefined) return undefined;
        out.push(v);
      }
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const k = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
      if (k === undefined) return undefined;
      const v = evalLiteral(p.initializer, rel, read, depth);
      if (v === undefined) return undefined;
      out[k] = v;
    }
    return out;
  }
  return undefined;
}

/**
 * A parameter of a forwarding helper, bound at one call of it: the argument as written in the caller's file, else the
 * parameter's default in the helper's file (`expr` undefined when neither exists).
 */
interface Bound {
  expr: ts.Expression | undefined;
  rel: string;
  consts: Map<string, ts.Expression>;
}
type Env = ReadonlyMap<string, Bound>;

/**
 * Functions the ops scripts load a compiled ABI through, by contract name. Each reads the compiled artifact of
 * that name, so `loader("<Name>")` resolves to ops/abis/v2/<Name>.json here; a name with no artifact there does not
 * resolve. `callee` is matched against the whole callee text in `file`. `evidence` must match the text of `from` (the file
 * that defines the loader): it is the line that makes the claim in `why` true, so a loader repointed elsewhere fails.
 */
export const ABI_LOADERS: ReadonlyArray<{ file: string; callee: RegExp; from: string; evidence: RegExp; why: string }> = [
  // (keeper-lifecycle) and (web-txs) import the same abiLoader from money/lib.mjs.
  ...['ops/rehearse-lifecycle/keeper-lifecycle/drive.mjs', 'ops/rehearse-lifecycle/keeper-lifecycle/earn.mjs', 'ops/rehearse-lifecycle/web-txs/run.mjs'].map((file) => ({
    file,
    callee: /A\.(withErrors|load)/,
    from: 'ops/rehearse-lifecycle/money/lib.mjs',
    evidence: /const load = \(name\) => \{[^}]*path\.join\(out, `\$\{name\}\.sol`, `\$\{name\}\.json`\)/,
    why: 'A = abiLoader(<the fork\'s contracts tree>) from money/lib.mjs: load / withErrors read out/<name>.sol/<name>.json of the rehearsed contracts tree, the compile ops/abis/v2 is exported from',
  })),
  {
    file: 'ops/v2/rehearse/lib.mjs',
    callee: /abiOf/,
    from: 'ops/v2/rehearse/lib.mjs',
    evidence: /ABI_DIR = path\.join\(ROOT, "ops", "abis", "v2"\);[\s\S]*function abiOf\(name\) \{\n\s*const abi = JSON\.parse\(readFileSync\(path\.join\(ABI_DIR, `\$\{name\}\.json`\)/,
    why: 'abiOf(name) reads ABI_DIR/<name>.json (plus V2Errors), and ABI_DIR is ops/abis/v2',
  },
  {
    file: 'ops/rehearse-lifecycle/monitor-faults.mjs',
    callee: /abiOf/,
    from: 'ops/rehearse-lifecycle/monitor-faults.mjs',
    evidence: /function abiOf\(name\) \{[^}]*readFileSync\(path\.join\(ROOT, "ops", "abis", "v2", `\$\{name\}\.json`\)/,
    why: 'abiOf(name) reads ops/abis/v2/<name>.json',
  },
  {
    file: 'ops/rehearse-lifecycle/weekend-drill/drill.mjs',
    callee: /A\.(withErrors|load)/,
    from: 'ops/rehearse-lifecycle/money/lib.mjs',
    evidence: /const load = \(name\) => \{[^}]*path\.join\(out, `\$\{name\}\.sol`, `\$\{name\}\.json`\)/,
    why: 'T-OP-667: A = abiLoader(<the rehearsed contracts tree>) from money/lib.mjs, as money/run.mjs',
  },
  {
    file: 'ops/rehearse-lifecycle/money/run.mjs',
    callee: /A\.(withErrors|load)/,
    from: 'ops/rehearse-lifecycle/money/lib.mjs',
    evidence: /const load = \(name\) => \{[^}]*path\.join\(out, `\$\{name\}\.sol`, `\$\{name\}\.json`\)/,
    why: 'A = abiLoader(<contracts tree>): load / withErrors read out/<name>.sol/<name>.json of the rehearsed contracts tree, the compile ops/abis/v2 is exported from',
  },
  {
    file: 'ops/rehearse-lifecycle/mm/mm.mjs',
    callee: /A\.(withErrors|load)/,
    from: 'ops/rehearse-lifecycle/money/lib.mjs',
    evidence: /const load = \(name\) => \{[^}]*path\.join\(out, `\$\{name\}\.sol`, `\$\{name\}\.json`\)/,
    why: 'the mm rehearsal (T-OP-666) imports money/lib.mjs abiLoader: A = abiLoader(<the rehearsal contracts tree>), the same loader as money/run.mjs',
  },
];

/**
 * An object one ops script builds and hands to another at runtime. web-txs/run.mjs builds `const env = { rd,
 * ABI, C, pub, ... }` out of its own bindings and calls flows.runAll(env), which keeps it as `E`; flows.mjs then reaches
 * the chain through `E.rd(...)`, `E.ABI.ch`, `E.C.orderBook` and `const { rd, C, ABI } = E`. In `file`, `name.key` (or a
 * name destructured from `name`) is property `key` of the `object` literal in `from`. `evidence` must match `from` and
 * `binds` must match `file`, so a hand-off that changes shape fails instead of resolving to something else.
 */
export const ENV_OBJECTS: ReadonlyArray<{ file: string; name: string; from: string; object: string; evidence: RegExp; binds: RegExp; why: string }> = [
  {
    file: 'ops/rehearse-lifecycle/web-txs/flows.mjs',
    name: 'E',
    from: 'ops/rehearse-lifecycle/web-txs/run.mjs',
    object: 'env',
    evidence: /\nconst env = \{[^}]*\};[\s\S]*\nawait flows\.runAll\(env\);/,
    binds: /\nlet E;\n[\s\S]*\nexport async function runAll\(env\) \{\n\s*E = env;/,
    why: 'run.mjs passes its env literal to flows.runAll, which assigns it to the module-level E before any flow runs',
  },
];

/** `obj.key` in `rel`, when `obj` is an ENV_OBJECTS name there: the expression that property holds, in its `from` file. */
function envMember(obj: string, key: string, rel: string, read: Reader): { expr: ts.Expression; rel: string } | undefined {
  const o = ENV_OBJECTS.find((x) => x.file === rel && x.name === obj);
  const init = o === undefined ? undefined : resolveConst(o.object, o.from, read);
  const lit = init === undefined ? undefined : unwrap(init.expr);
  const v = lit !== undefined && ts.isObjectLiteralExpression(lit) ? prop(lit, key) : undefined;
  return v === undefined ? undefined : { expr: v, rel: o!.from };
}

/** `const { rd, ABI: A } = E` in `rel`, E an ENV_OBJECTS name there: the property `name` was destructured from. */
function envMemberOfName(name: string, rel: string, sf: ts.SourceFile, read: Reader): { expr: ts.Expression; rel: string } | undefined {
  let hit: { obj: string; key: string } | undefined;
  const visit = (n: ts.Node): void => {
    if (hit === undefined && ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      if (ts.isIdentifier(init) && ENV_OBJECTS.some((o) => o.file === rel && o.name === init.text)) {
        for (const el of n.name.elements) {
          if (el.dotDotDotToken !== undefined || !ts.isIdentifier(el.name) || el.name.text !== name) continue;
          hit = { obj: init.text, key: el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name };
        }
      }
    }
    if (hit === undefined) ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit === undefined ? undefined : envMember(hit.obj, hit.key, rel, read);
}

/** The initializer a name is bound to by `const`, in this file or (through an import) in the file that declares it. */
function resolveConst(name: string, rel: string, read: Reader, depth = 0): { expr: ts.Expression; rel: string } | undefined {
  const text = depth > 4 ? null : read(rel);
  if (text === null) return undefined;
  const sf = parse(rel, text);
  const local = constsOf(sf).get(name);
  if (local !== undefined) return { expr: local, rel };
  // `const { ABI } = E` (ENV_OBJECTS): what E's property holds where E was built.
  const member = envMemberOfName(name, rel, sf, read);
  if (member !== undefined) {
    const u = unwrap(member.expr);
    return ts.isIdentifier(u) ? resolveConst(u.text, member.rel, read, depth + 1) : member;
  }
  const imp = importsOf(sf).get(name);
  const target = imp === undefined ? null : resolveSpec(rel, imp.spec, read);
  return target === null ? undefined : resolveConst(imp!.name, target, read, depth + 1);
}

/** `const { a, b: c } = viem` or `= createRequire(...)("viem")`: the viem export a destructured local name denotes. */
function viemBinding(name: string, sf: ts.SourceFile): string | undefined {
  let out: string | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      const arg = ts.isCallExpression(init) && init.arguments.length === 1 ? init.arguments[0]! : undefined;
      if ((ts.isIdentifier(init) && init.text === 'viem') || (arg !== undefined && ts.isStringLiteral(arg) && arg.text === 'viem')) {
        for (const el of n.name.elements) {
          if (ts.isIdentifier(el.name) && el.name.text === name) out = el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The monitor's table `Object.fromEntries(Object.entries(X).map(([k, v]) => [k, parseAbi(v)]))`: X, else undefined. */
function parseAbiTableOf(e: ts.Expression): ts.Expression | undefined {
  e = unwrap(e);
  if (!ts.isCallExpression(e) || e.expression.getText() !== 'Object.fromEntries' || e.arguments.length !== 1) return undefined;
  const m = unwrap(e.arguments[0]!);
  if (!ts.isCallExpression(m) || !ts.isPropertyAccessExpression(m.expression) || m.expression.name.text !== 'map' || m.arguments.length !== 1) return undefined;
  const entries = unwrap(m.expression.expression);
  if (!ts.isCallExpression(entries) || entries.expression.getText() !== 'Object.entries' || entries.arguments.length !== 1) return undefined;
  return /^\(\[(\w+),(\w+)\]\)=>\[\1,parseAbi\(\2\)\]$/.test(m.arguments[0]!.getText().replace(/\s+/g, '')) ? entries.arguments[0] : undefined;
}

/** A call through ABI_LOADERS: the compiled artifact it names. null when the call is not a loader, undefined when its name does not resolve. */
function loadedAbi(e: ts.CallExpression, rel: string, read: Reader, env?: Env): unknown[] | undefined | null {
  const callee = e.expression.getText().replace(/\s+/g, '');
  if (!ABI_LOADERS.some((l) => l.file === rel && new RegExp(`^(?:${l.callee.source})$`).test(callee))) return null;
  let arg = e.arguments.length === 1 ? unwrap(e.arguments[0]!) : undefined;
  if (arg !== undefined && ts.isIdentifier(arg) && env?.has(arg.text)) {
    const b = env.get(arg.text)!.expr;
    arg = b === undefined ? undefined : unwrap(b);
  }
  const name = arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
  const raw = name === undefined || !/^\w+$/.test(name) ? null : read(`ops/abis/v2/${name}.json`);
  if (raw === null) return undefined;
  const json = JSON.parse(raw) as unknown;
  return Array.isArray(json) ? json : (json as { abi: unknown[] }).abi;
}

/**
 * The ABI value an expression denotes: a literal, a parseAbi call, a local const, an import, viem's built-in (imported
 * or destructured from viem), an ABI_LOADERS load, `X.key` of an object of those or of the monitor's parseAbi table, or
 * (through `env`) a forwarding helper's parameter bound at its call.
 */
function resolveAbiValue(e: ts.Expression, rel: string, read: Reader, depth = 0, env?: Env): unknown[] | undefined {
  e = unwrap(e);
  if (depth > 6) return undefined;
  if (env !== undefined && ts.isIdentifier(e) && env.has(e.text)) {
    const b = env.get(e.text)!;
    return b.expr === undefined ? undefined : resolveAbiValue(b.expr, b.rel, read, depth + 1);
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'parseAbi' && e.arguments[0] !== undefined) {
    const items = evalLiteral(e.arguments[0], rel, read, depth);
    return Array.isArray(items) && items.every((s) => typeof s === 'string') ? ([...parseAbi(items as string[])] as unknown[]) : undefined;
  }
  if (ts.isCallExpression(e)) {
    const loaded = loadedAbi(e, rel, read, env);
    if (loaded !== null) return loaded;
    // monitor-faults `human("approve(address,uint256) returns (bool)", ...)`, defined as
    // `(...sigs) => parseAbi(sigs.map((s) => `function ${s}`))`.
    const helper = ts.isIdentifier(e.expression) ? resolveConst(e.expression.text, rel, read) : undefined;
    const body = helper === undefined ? '' : helper.expr.getText().replace(/\s+/g, '');
    if (/^\(\.\.\.(\w+)\)=>parseAbi\(\1\.map\(\((\w+)\)=>`function\$\{\2\}`\)\)$/.test(body)) {
      const sigs = e.arguments.map((a) => evalLiteral(a, rel, read, depth));
      return sigs.every((x) => typeof x === 'string') ? ([...parseAbi(sigs.map((x) => `function ${x as string}`))] as unknown[]) : undefined;
    }
    return undefined;
  }
  if (ts.isArrayLiteralExpression(e)) {
    const v = evalLiteral(e, rel, read, depth);
    return Array.isArray(v) ? v : undefined;
  }
  // `E.ABI.ch` (ENV_OBJECTS): `ABI.ch` where E was built.
  if (ts.isPropertyAccessExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
    const m = envMember(e.expression.expression.text, e.expression.name.text, rel, read);
    const u = m === undefined ? undefined : unwrap(m.expr);
    if (u === undefined || !ts.isIdentifier(u)) return undefined;
    return resolveAbiValue(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(u.text), e.name.text), m!.rel, read, depth + 1);
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    // `E.erc20Abi` (ENV_OBJECTS).
    const member = envMember(e.expression.text, e.name.text, rel, read);
    if (member !== undefined) return resolveAbiValue(member.expr, member.rel, read, depth + 1);
    const owner = resolveConst(e.expression.text, rel, read);
    const o = owner === undefined ? undefined : unwrap(owner.expr);
    if (o === undefined) return undefined;
    if (ts.isObjectLiteralExpression(o)) {
      const v = prop(o, e.name.text);
      return v === undefined ? undefined : resolveAbiValue(v, owner!.rel, read, depth + 1);
    }
    const table = parseAbiTableOf(o);
    const tableName = table === undefined ? undefined : unwrap(table);
    const src = tableName !== undefined && ts.isIdentifier(tableName) ? resolveConst(tableName.text, owner!.rel, read) : undefined;
    const obj = src === undefined ? undefined : unwrap(src.expr);
    const frag = obj !== undefined && ts.isObjectLiteralExpression(obj) ? prop(obj, e.name.text) : undefined;
    const items = frag === undefined ? undefined : evalLiteral(frag, src!.rel, read, depth);
    return Array.isArray(items) && items.every((s) => typeof s === 'string') ? ([...parseAbi(items as string[])] as unknown[]) : undefined;
  }
  if (!ts.isIdentifier(e)) return undefined;
  const text = read(rel);
  if (text === null) return undefined;
  const sf = parse(rel, text);
  const local = constsOf(sf).get(e.text);
  if (local !== undefined) return resolveAbiValue(local, rel, read, depth + 1);
  const imp = importsOf(sf).get(e.text);
  if (imp === undefined) {
    const name = viemBinding(e.text, sf);
    const v = name === undefined ? undefined : (viem as Record<string, unknown>)[name];
    return Array.isArray(v) ? (v as unknown[]) : undefined;
  }
  if (imp.spec === 'viem') {
    const v = (viem as Record<string, unknown>)[imp.name];
    return Array.isArray(v) ? (v as unknown[]) : undefined;
  }
  const target = resolveSpec(rel, imp.spec, read);
  if (target === null) return undefined;
  return resolveAbiValue(ts.factory.createIdentifier(imp.name), target, read, depth + 1);
}

/** A human label for the ABI a call site passes: the generated module's source artifact when it has one. */
function abiLabel(e: ts.Expression, rel: string, read: Reader, env?: Env): string {
  e = unwrap(e);
  if (env !== undefined && ts.isIdentifier(e) && env.has(e.text)) {
    const b = env.get(e.text)!;
    return b.expr === undefined ? `${e.text} (unbound)` : abiLabel(b.expr, b.rel, read);
  }
  if (env !== undefined && ts.isCallExpression(e) && e.arguments.length === 1 && ts.isIdentifier(e.arguments[0]!) && env.has(e.arguments[0].text)) {
    const b = env.get(e.arguments[0].text)!;
    return `${e.expression.getText()}(${b.expr?.getText() ?? 'unbound'})`;
  }
  if (!ts.isIdentifier(e)) return e.getText();
  const text = read(rel);
  const sf = text === null ? null : parse(rel, text);
  const imp = sf === null ? undefined : importsOf(sf).get(e.text);
  if (imp !== undefined) {
    const target = resolveSpec(rel, imp.spec, read);
    const head = target === null ? null : (read(target) ?? '').slice(0, 400);
    const m = head?.match(/from (ops\/abis\/[\w/]+\.json)/);
    if (m) return `${imp.name} (${m[1]})`;
    return `${imp.name} (${imp.spec})`;
  }
  return `${e.text} (${rel})`;
}

/** Every string the functionName expression can be: a literal, a ternary of literals, or a local const of those. */
function fnNames(e: ts.Expression, consts: Map<string, ts.Expression>, depth = 0, env?: Env): string[] | null {
  e = unwrap(e);
  if (env !== undefined && ts.isIdentifier(e) && env.has(e.text)) {
    const b = env.get(e.text)!;
    return b.expr === undefined ? null : fnNames(b.expr, b.consts, depth);
  }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  // `["paused", "oraclePaused"][i]`: any of them.
  const strings = (x: ts.Expression): string[] | null => {
    const u = unwrap(x);
    return ts.isArrayLiteralExpression(u) && u.elements.every((el) => ts.isStringLiteral(el)) ? u.elements.map((el) => (el as ts.StringLiteral).text) : null;
  };
  if (ts.isElementAccessExpression(e)) return strings(e.expression);
  // `for (const fn of ["nonce", "getThreshold"]) add(safe, SAFE_VIEWS, fn)`: each of them.
  if (ts.isIdentifier(e) && e.parent !== undefined) {
    for (let p: ts.Node | undefined = e.parent; p !== undefined; p = p.parent) {
      if (!ts.isForOfStatement(p) || !ts.isVariableDeclarationList(p.initializer)) continue;
      const d = p.initializer.declarations[0];
      if (d !== undefined && ts.isIdentifier(d.name) && d.name.text === e.text) return strings(p.expression);
      // `for (const [k, fn] of [["a", "b"], ["c", "d"]])`: position i of each row.
      const i = d !== undefined && ts.isArrayBindingPattern(d.name) ? d.name.elements.findIndex((el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === e.text) : -1;
      const rows = unwrap(p.expression);
      if (i >= 0 && ts.isArrayLiteralExpression(rows)) {
        const cells = rows.elements.map((r) => (ts.isArrayLiteralExpression(r) ? r.elements[i] : undefined));
        return cells.every((c) => c !== undefined && ts.isStringLiteral(c)) ? cells.map((c) => (c as ts.StringLiteral).text) : null;
      }
    }
  }
  if (ts.isConditionalExpression(e)) {
    const a = fnNames(e.whenTrue, consts, depth);
    const b = fnNames(e.whenFalse, consts, depth);
    return a === null || b === null ? null : [...a, ...b];
  }
  if (ts.isIdentifier(e) && depth < 3) {
    const c = consts.get(e.text);
    return c === undefined ? null : fnNames(c, consts, depth + 1);
  }
  return null;
}

/** Normalise an address expression for rule matching: no whitespace, casts, non-null marks or getAddress(). */
export function normAddress(text: string): string {
  let t = text.replace(/\s+/g, '');
  t = t.replace(/as`0x\$\{string\}`/g, '').replace(/asAddress/g, '').replace(/!/g, '');
  const g = t.match(/^getAddress\((.*)\)$/);
  if (g) t = g[1]!;
  const p = t.match(/^\((.*)\)$/);
  if (p) t = p[1]!;
  return t;
}

function prop(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** `{ ...v, functionName }`: the object literal a spread identifier names, when it is a local const. */
function spreadSources(o: ts.ObjectLiteralExpression, consts: Map<string, ts.Expression>): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  for (const p of o.properties) {
    if (!ts.isSpreadAssignment(p)) continue;
    const e = unwrap(p.expression);
    const init = ts.isIdentifier(e) ? consts.get(e.text) : undefined;
    const obj = init === undefined ? undefined : unwrap(init);
    if (obj !== undefined && ts.isObjectLiteralExpression(obj)) out.push(obj);
  }
  return out;
}

/** For `encodeFunctionData({ abi, functionName })` with no address: the `to` of the nearest enclosing object literal. */
function enclosingTo(n: ts.Node): ts.Expression | undefined {
  for (let p = n.parent; p !== undefined; p = p.parent) {
    if (ts.isObjectLiteralExpression(p)) {
      const to = prop(p, 'to') ?? prop(p, 'target');
      if (to !== undefined) return to;
    }
    if (ts.isFunctionLike(p)) return undefined;
  }
  return undefined;
}

function ruleFor(site: Site, rules: readonly KindRule[]): KindRule | undefined {
  return rules.find(
    (r) =>
      r.file.test(site.file) &&
      new RegExp(`^(?:${r.address.source})$`).test(site.address) &&
      (r.inFn === undefined || new RegExp(`^(?:${r.inFn.source})$`).test(site.ctx)) &&
      (r.fn === undefined || (site.fns.length > 0 && site.fns.every((f) => new RegExp(`^(?:${r.fn!.source})$`).test(f)))),
  );
}

/** The name of the nearest named enclosing function-like: `function f`, a method, `const f = () =>`, `f: () =>`. */
function contextOf(n: ts.Node): string {
  for (let p = n.parent; p !== undefined; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name !== undefined) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && (ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent)) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return '';
}

/**
 * An identifier address bound by a `const` in an enclosing block (before the call): follow it to its initializer, up
 * to three hops, so `const address = requireV2Address("clearinghouse")` classifies by what it holds. Parameters and
 * anything else stay as written.
 */
function followLocal(e: ts.Expression): ts.Expression {
  for (let hop = 0; hop < 3; hop++) {
    const u = unwrap(e);
    if (!ts.isIdentifier(u)) return e;
    let found: ts.Expression | undefined;
    for (let p: ts.Node | undefined = u.parent; p !== undefined && found === undefined; p = p.parent) {
      if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
      for (const st of p.statements) {
        if (st.getStart() >= u.getStart()) break;
        if (!ts.isVariableStatement(st) || (st.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === u.text && d.initializer !== undefined) found = d.initializer;
      }
    }
    // Follow only what names an address: another name, a property path, or a call like requireV2Address("x").
    // An awaited read or a conditional stays as the identifier the rule then names.
    const f = found === undefined ? undefined : unwrap(found);
    const simple =
      f !== undefined &&
      (ts.isIdentifier(f) ||
        ts.isPropertyAccessExpression(f) ||
        ts.isElementAccessExpression(f) ||
        (ts.isCallExpression(f) && ts.isIdentifier(f.expression) && f.arguments.every((a) => ts.isStringLiteral(a) || ts.isIdentifier(a) || ts.isPropertyAccessExpression(a))));
    if (!simple) return e;
    e = found!;
  }
  return e;
}

/** A function that forwards `(address, abi, functionName, args)` to viem: its CALLERS are the call sites. */
interface Wrapper {
  decl: ts.SignatureDeclaration;
  abi: number;
  functionName: number;
  address: number | null;
  args: number | null;
}

const ADDRESS_PARAMS = new Set(['address', 'to', 'target', 'contract', 'addr']);

/** A function taking an `abi` and a function name is a wrapper; undefined otherwise. */
function asWrapper(fn: ts.SignatureDeclaration): Wrapper | undefined {
  const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  const abi = names.indexOf('abi');
  // `fn` is the ops scripts' spelling (money/run.mjs `read(address, abi, fn, a)`, monitor-faults setViewUint).
  const functionName = names.includes('functionName') ? names.indexOf('functionName') : names.indexOf('fn');
  if (abi < 0 || functionName < 0) return undefined;
  const address = names.findIndex((n) => ADDRESS_PARAMS.has(n));
  const args = names.indexOf('args');
  return { decl: fn, abi, functionName, address: address < 0 ? null : address, args: args < 0 ? null : args };
}

const wrapperCache = new Map<string, Map<string, Wrapper>>();
function wrappersOf(rel: string, read: Reader): Map<string, Wrapper> {
  const hit = wrapperCache.get(rel);
  if (hit !== undefined) return hit;
  const out = new Map<string, Wrapper>();
  wrapperCache.set(rel, out);
  const text = read(rel);
  if (text === null) return out;
  const sf = parse(rel, text);
  const consider = (name: string, fn: ts.SignatureDeclaration): void => {
    const w = asWrapper(fn);
    if (w !== undefined) out.set(name, w);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined && ts.isIdentifier(n.name)) consider(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) consider(n.name.text, init);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The file a name comes from when it is imported, or bound to the result of an imported factory (`const fork = makeFork(conn)`). */
function originOf(name: string, rel: string, sf: ts.SourceFile, read: Reader): string | null {
  const imports = importsOf(sf);
  const init = constsOf(sf).get(name);
  const u = init === undefined ? undefined : unwrap(init);
  const via = imports.get(name) ?? (u !== undefined && ts.isCallExpression(u) && ts.isIdentifier(u.expression) ? imports.get(u.expression.text) : undefined);
  return via === undefined ? null : resolveSpec(rel, via.spec, read);
}

/** The wrapper a call's callee names, in this file or through an import. */
function wrapperFor(callee: ts.Expression, rel: string, sf: ts.SourceFile, read: Reader): Wrapper | undefined {
  // `this.write(...)`: a method of a class in the same file.
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) return wrappersOf(rel, read).get(callee.name.text);
  // `fork.read(...)` (money/lib.mjs makeFork) or `ctx.chain.send(...)` (monitor-faults.mjs): a wrapper of that name in the
  // file the object comes from, else in this file.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const obj = unwrap(callee.expression);
    if (ts.isIdentifier(obj)) {
      // `E.rd(...)` (ENV_OBJECTS): the wrapper E's property names where E was built, never a local of the same name.
      const m = envMember(obj.text, callee.name.text, rel, read);
      if (m !== undefined) return wrapperNamed(m.expr, m.rel, read);
      const returned = returnedWrapper(obj, callee.name.text);
      if (returned !== undefined) return returned;
    }
    const origin = ts.isIdentifier(obj) ? originOf(obj.text, rel, sf, read) : null;
    return (origin === null ? undefined : wrappersOf(origin, read).get(callee.name.text)) ?? wrappersOf(rel, read).get(callee.name.text);
  }
  if (!ts.isIdentifier(callee)) return undefined;
  const local = wrappersOf(rel, read).get(callee.text);
  if (local !== undefined) return local;
  // `const { rd } = E; rd(...)` (ENV_OBJECTS).
  const member = envMemberOfName(callee.text, rel, sf, read);
  if (member !== undefined) return wrapperNamed(member.expr, member.rel, read);
  const imp = importsOf(sf).get(callee.text);
  const target = imp === undefined ? null : resolveSpec(rel, imp.spec, read);
  return target === null || imp === undefined ? undefined : wrappersOf(target, read).get(imp.name);
}

/** The wrapper an expression names in `rel` (an identifier bound there), or undefined. */
function wrapperNamed(e: ts.Expression, rel: string, read: Reader): Wrapper | undefined {
  const u = unwrap(e);
  return ts.isIdentifier(u) ? wrappersOf(rel, read).get(u.text) : undefined;
}

/**
 * `k.send(...)` where `const k = await sender(label)` in an enclosing block and the function `sender` returns an object
 * literal whose `send` is a wrapper (web-txs flows.mjs sender): that function. Scoped like followLocal, so a
 * `const k` of another shape elsewhere in the file does not answer.
 */
function returnedWrapper(obj: ts.Identifier, method: string): Wrapper | undefined {
  const nearest = <T>(from: ts.Node, pick: (st: ts.Statement) => T | undefined, before?: number): T | undefined => {
    for (let p: ts.Node | undefined = from.parent; p !== undefined; p = p.parent) {
      if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
      for (const st of p.statements) {
        if (before !== undefined && st.getStart() >= before) break;
        const hit = pick(st);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const constInit = nearest(
    obj,
    (st) => (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const) !== 0 ? st.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === obj.text)?.initializer : undefined),
    obj.getStart(),
  );
  let call = constInit === undefined ? undefined : unwrap(constInit);
  if (call !== undefined && ts.isAwaitExpression(call)) call = unwrap(call.expression);
  if (call === undefined || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined;
  const factoryName = call.expression.text;
  const factory = nearest<ts.SignatureDeclaration>(call, (st) => {
    if (ts.isFunctionDeclaration(st) && st.name?.text === factoryName) return st;
    if (!ts.isVariableStatement(st)) return undefined;
    const d = st.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === factoryName);
    const init = d?.initializer === undefined ? undefined : unwrap(d.initializer);
    return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
  });
  const body = factory === undefined ? undefined : (factory as ts.FunctionLikeDeclaration).body;
  if (body === undefined) return undefined;
  // The object literals the factory itself returns (not those of a function nested in it).
  const returned: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression !== undefined && ts.isObjectLiteralExpression(unwrap(n.expression))) returned.push(unwrap(n.expression) as ts.ObjectLiteralExpression);
    ts.forEachChild(n, visit);
  };
  if (ts.isBlock(body)) ts.forEachChild(body, visit);
  else if (ts.isObjectLiteralExpression(unwrap(body as ts.Expression))) returned.push(unwrap(body as ts.Expression) as ts.ObjectLiteralExpression);
  for (const o of returned) {
    const m = prop(o, method);
    const f = m === undefined ? undefined : unwrap(m);
    if (f !== undefined && (ts.isArrowFunction(f) || ts.isFunctionExpression(f))) return asWrapper(f);
  }
  return undefined;
}

/** True when this block, loop or file itself declares `name` (a `const` / `let` / `var`, a function, a loop variable). */
function declaresHere(p: ts.Node, name: string): boolean {
  const binds = (b: ts.BindingName): boolean => (ts.isIdentifier(b) ? b.text === name : b.elements.some((el) => !ts.isOmittedExpression(el) && binds(el.name)));
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isForStatement(p)) && p.initializer !== undefined && ts.isVariableDeclarationList(p.initializer)) {
    return p.initializer.declarations.some((d) => binds(d.name));
  }
  if (!ts.isBlock(p) && !ts.isSourceFile(p)) return false;
  return p.statements.some(
    (st) => (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => binds(d.name))) || (ts.isFunctionDeclaration(st) && st.name?.text === name),
  );
}

/**
 * The function whose PARAMETER a name is, looking outward from where it is used the way scoping does, and stopping at a
 * nearer local declaration of it. `key` is null for a plain parameter, else the property it is destructured from
 * (`{ fn, abi }` binds fn from key 'fn'; `{ functionName: f }` binds f from key 'functionName').
 */
function binderOf(id: ts.Identifier): { fn: ts.SignatureDeclaration; key: string | null } | null {
  const find = (b: ts.BindingName, key: string | null): string | null | undefined => {
    if (ts.isIdentifier(b)) return b.text === id.text ? key : undefined;
    for (const el of b.elements) {
      if (ts.isOmittedExpression(el)) continue;
      const k = ts.isObjectBindingPattern(b) ? (el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '') : '';
      const hit = find(el.name, k);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (let p: ts.Node | undefined = id.parent; p !== undefined; p = p.parent) {
    if (declaresHere(p, id.text)) return null;
    if (!ts.isFunctionLike(p)) continue;
    for (const q of p.parameters) {
      const key = find(q.name, null);
      if (key !== undefined) return { fn: p, key };
    }
  }
  return null;
}

/**
 * Whether a sink (an object literal carrying `functionName`, or a wrapper call) forwards the parameters of a function
 * around it rather than fixing a call itself.
 *
 *   positional  its abi or its function name is a parameter the callers pass some other way than as an object literal
 *               keyed `abi` / `functionName`: `(address, abi, functionName) => ...`, `(fn) => read(X, ABI.x, fn)`,
 *               `storageFlag({ target, fn, abi })`. The function's CALLERS are the call sites, and the scan must follow
 *               at least one of them (wrapperFor / partialFor), or the sink is reported unresolved.
 *   object      both come out of an object parameter under exactly the keys `abi` and `functionName`
 *               (`send(from, { address, abi, functionName })`, `(c) => read(c.address, c.abi, c.functionName)`). Then
 *               every caller spells `functionName:` and `abi:` in an object literal of its own, and the scan visits that
 *               literal as a call site wherever it is written; nothing further to follow.
 *   null        the sink fixes both itself: it is a call site.
 */
function forwarding(n: ts.Node, abiExpr: ts.Expression | undefined, fnExpr: ts.Expression | undefined): { fn: ts.SignatureDeclaration; form: 'positional' | 'object' } | null {
  const classify = (x: ts.Expression | undefined, key: 'abi' | 'functionName'): { fn: ts.SignatureDeclaration; form: 'positional' | 'object' } | null => {
    const e = x === undefined ? undefined : unwrap(x);
    if (e !== undefined && ts.isIdentifier(e)) {
      const b = binderOf(e);
      return b === null ? null : { fn: b.fn, form: b.key === key ? 'object' : 'positional' };
    }
    if (e !== undefined && ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const b = binderOf(e.expression);
      return b === null || b.key !== null ? null : { fn: b.fn, form: e.name.text === key ? 'object' : 'positional' };
    }
    return null;
  };
  const f = classify(fnExpr, 'functionName');
  const a = classify(abiExpr, 'abi');
  if (f?.form === 'positional') return f;
  if (a?.form === 'positional') return a;
  return f ?? a;
}

/**
 * A helper that forwards its own parameter as the function name, with the abi (and usually the address) fixed or taken
 * from other parameters: `const call = (functionName: string) => ({ abi: earnVaultAbi, address: vault, functionName })`,
 * `const ch = (fn, args = []) => read(C.clearinghouse, ABI.clearinghouse, fn, args)`, monitor-faults
 * `view(ctx, name, to, fn, args)` over `ctx.chain.read(to, abiOf(name), fn, args)`. Its callers are the call sites: each
 * binds the parameters (`Env`) and the sink is checked with them. Resolved through the enclosing scopes like followLocal,
 * then through an import.
 */
interface Partial {
  decl: ts.SignatureDeclaration;
  rel: string;
  address: ts.Expression | undefined;
  abi: ts.Expression;
  functionName: ts.Expression;
  args: ts.Expression | undefined;
  noArgs: boolean;
}

function partialIn(decl: ts.SignatureDeclaration, rel: string, read: Reader): Partial[] {
  const body = (decl as ts.FunctionLikeDeclaration).body;
  const text = read(rel);
  if (body === undefined || text === null) return [];
  const sf = parse(rel, text);
  // The function name must be one of decl's own plain parameters (the argument its callers pass), and the sink must
  // forward it for decl, not for a function nested inside it.
  const own = (e: ts.Expression | undefined): boolean => {
    const u = e === undefined ? undefined : unwrap(e);
    const b = u !== undefined && ts.isIdentifier(u) ? binderOf(u) : null;
    return b !== null && b.fn === decl && b.key === null;
  };
  const found: Partial[] = [];
  const find = (n: ts.Node): void => {
    const fw = (abi: ts.Expression | undefined, fnx: ts.Expression | undefined): boolean => own(fnx) && forwarding(n, abi, fnx)?.fn === decl;
    if (ts.isObjectLiteralExpression(n)) {
      const abi = prop(n, 'abi');
      const fnx = prop(n, 'functionName');
      if (abi !== undefined && fnx !== undefined && fw(abi, fnx)) found.push({ decl, rel, address: prop(n, 'address') ?? enclosingTo(n), abi, functionName: fnx, args: prop(n, 'args'), noArgs: true });
    }
    if (ts.isCallExpression(n)) {
      const w = wrapperFor(n.expression, rel, sf, read);
      const a = n.arguments;
      if (w !== undefined && a[w.abi] !== undefined && a[w.functionName] !== undefined && fw(a[w.abi], a[w.functionName])) {
        found.push({
          decl,
          rel,
          address: w.address === null ? undefined : a[w.address],
          abi: a[w.abi]!,
          functionName: a[w.functionName]!,
          args: w.args === null ? undefined : a[w.args],
          noArgs: w.args !== null && a[w.args] === undefined,
        });
      }
    }
    ts.forEachChild(n, find);
  };
  find(body);
  // Several sinks. Each that names an address is a call of its own and is checked against what it is sent to: a helper
  // that reads the treasury MakerVault on one branch and a House vault on the other must hold on both (the
  // first-sink-only check let a House askFloor read, the bug, pass). A sink with no address (locateFlag reads the
  // flag, then encodes the same call for an access list) is that same call again, checked only when no sink names one.
  const addressed = found.filter((f) => f.address !== undefined);
  return addressed.length > 0 ? addressed : found.slice(0, 1);
}

function partialFor(callee: ts.Expression, rel: string, sf: ts.SourceFile, read: Reader): Partial[] {
  if (!ts.isIdentifier(callee)) return [];
  for (let p: ts.Node | undefined = callee.parent; p !== undefined; p = p.parent) {
    if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
    for (const st of p.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === callee.text) return partialIn(st, rel, read);
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== callee.text || d.initializer === undefined) continue;
        const fn = unwrap(d.initializer);
        return ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? partialIn(fn, rel, read) : [];
      }
    }
  }
  const imp = importsOf(sf).get(callee.text);
  const target = imp === undefined ? null : resolveSpec(rel, imp.spec, read);
  const ttext = target === null ? null : read(target);
  if (ttext === null) return [];
  const tsf = parse(target!, ttext);
  const decl = tsf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === imp!.name);
  if (decl !== undefined) return partialIn(decl, target!, read);
  const init = constsOf(tsf).get(imp!.name);
  const fn = init === undefined ? undefined : unwrap(init);
  return fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? partialIn(fn, target!, read) : [];
}

/** Scan the given files. `read` serves every file the scanner needs (sources and the ABI modules they import). */
export function scan(files: readonly string[], read: Reader, rules: readonly KindRule[], compiled: Map<Kind, AbiFunction[]>): ScanResult {
  const sites: Site[] = [];
  const violations: string[] = [];
  const unresolved: Unresolved[] = [];
  const cannot = (u: Omit<Unresolved, 'text'>, text: string): void => {
    violations.push(text);
    unresolved.push({ ...u, text });
  };
  // Sinks that forward their enclosing function's abi / functionName positionally are not sites; that function's
  // CALLERS are. Each such function must have at least one caller the scan followed, or its calls would vanish unchecked.
  const forwarders: Array<{ fn: ts.Node; file: string; line: number; ctx: string }> = [];
  const followed = new Set<ts.Node>();
  const constsCache = new Map<string, Map<string, ts.Expression>>();
  const constsIn = (rel: string): Map<string, ts.Expression> => {
    let c = constsCache.get(rel);
    if (c === undefined) {
      const text = read(rel);
      c = text === null ? new Map() : constsOf(parse(rel, text));
      constsCache.set(rel, c);
    }
    return c;
  };
  for (const rel of files) {
    const text = read(rel);
    // No text pre-filter on 'functionName': a file that only calls an imported write wrapper never spells it.
    if (text === null) continue;
    const sf = parse(rel, text);
    const consts = constsOf(sf);
    const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    /**
     * One call site. Its expressions are written in `sinkRel` (this file, unless it is an imported helper's sink); a
     * name in `env` is a helper parameter, read as the argument this call binds to it.
     */
    const handle = (
      n: ts.Node,
      addrExpr: ts.Expression | undefined,
      abiExpr: ts.Expression,
      fnExpr: ts.Expression,
      argsExpr: ts.Expression | undefined,
      noArgs: boolean,
      env?: Env,
      sinkRel: string = rel,
    ): void => {
      const line = lineOf(n);
      const where = `${rel}:${line}`;
      const ctx = contextOf(n);
      const bind = (e: ts.Expression | undefined): ts.Expression | undefined => {
        const u = e === undefined ? undefined : unwrap(e);
        return u !== undefined && env !== undefined && ts.isIdentifier(u) && env.has(u.text) ? env.get(u.text)!.expr : e;
      };
      const fns = fnNames(fnExpr, constsIn(sinkRel), 0, env);
      const argsB = bind(argsExpr);
      const argsU = argsB === undefined ? undefined : unwrap(argsB);
      const arity = argsU === undefined ? (noArgs || argsExpr !== undefined ? 0 : null) : ts.isArrayLiteralExpression(argsU) && !argsU.elements.some(ts.isSpreadElement) ? argsU.elements.length : null;
      const addrB = bind(addrExpr);
      const address = addrB === undefined ? '<none>' : normAddress(followLocal(addrB).getText(addrB.getSourceFile()));
      const site: Site = { file: rel, line, ctx, address, abi: abiLabel(abiExpr, sinkRel, read, env), fns: fns ?? [], arity, kinds: null, rule: null, checked: false };
      sites.push(site);
      const rule = ruleFor(site, rules);
      if (rule === undefined) {
        violations.push(`${where}: unclassified call site in ${site.ctx || '<module>'}: address \`${address}\`, abi ${site.abi}, function ${fns?.join('|') ?? '<dynamic>'}. Add a KIND_RULES entry naming what this address holds.`);
        return;
      }
      site.kinds = rule.kinds;
      site.rule = rule;
      if (rule.kinds === EXTERNAL) return;
      if (fns === null) {
        cannot({ file: rel, line, ctx }, `${where}: functionName is not a literal the test can read; name the literal(s) or narrow the rule.`);
        return;
      }
      const abi = resolveAbiValue(abiExpr, sinkRel, read, 0, env);
      if (abi === undefined) {
        cannot({ file: rel, line, ctx }, `${where}: cannot resolve abi ${site.abi} to a literal, parseAbi fragment or generated module.`);
        // Still a claim the test can check: the function NAME must exist on every kind the address can hold.
        for (const kind of rule.kinds) {
          for (const name of fns) {
            if (!(compiled.get(kind) ?? []).some((g) => g.name === name)) violations.push(`${where}: ${name} called on \`${address}\`, which can be a ${kind}; ${kind} has no ${name} (checked by name only: the abi is unresolved).`);
          }
        }
        return;
      }
      site.checked = true;
      checkSite(where, site, abi as Array<{ type: string }>, rule.kinds, compiled, violations);
    };

    /** A positionally forwarding sink: not a site, but its function must be followed from a caller. */
    const forwarder = (n: ts.Node, fn: ts.Node): void => {
      forwarders.push({ fn, file: rel, line: lineOf(n), ctx: contextOf(n) });
    };

    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n) && prop(n, 'functionName') !== undefined) {
        const sources = [n, ...spreadSources(n, consts)];
        const pick = (name: string): ts.Expression | undefined => sources.map((o) => prop(o, name)).find((x) => x !== undefined);
        const abiExpr = pick('abi');
        const unfollowed = n.properties.filter(ts.isSpreadAssignment).length > sources.length - 1;
        if (abiExpr === undefined) {
          // No abi: a record that happens to carry a function name (a journal row), unless a spread we cannot follow
          // could be supplying one.
          if (unfollowed) cannot({ file: rel, line: lineOf(n), ctx: contextOf(n) }, `${rel}:${lineOf(n)}: functionName with an abi-less literal and a spread the test cannot follow.`);
        } else {
          const fw = forwarding(n, abiExpr, prop(n, 'functionName'));
          // `decodeFunctionResult({ abi, functionName, data })` carries no args and says nothing about the arity.
          if (fw === null) handle(n, pick('address') ?? enclosingTo(n), abiExpr, prop(n, 'functionName')!, prop(n, 'args'), prop(n, 'data') === undefined);
          else if (fw.form === 'positional') forwarder(n, fw.fn);
        }
      }
      if (ts.isCallExpression(n)) {
        const w = wrapperFor(n.expression, rel, sf, read);
        const a = n.arguments;
        if (w !== undefined && a[w.abi] !== undefined && a[w.functionName] !== undefined) {
          const fw = forwarding(n, a[w.abi], a[w.functionName]);
          if (fw === null) handle(n, w.address === null ? undefined : a[w.address], a[w.abi]!, a[w.functionName]!, w.args === null ? undefined : a[w.args], w.args !== null && a[w.args] === undefined);
          else if (fw.form === 'positional') forwarder(n, fw.fn);
          followed.add(w.decl);
        }
        for (const part of w === undefined ? partialFor(n.expression, rel, sf, read) : []) {
          const pconsts = constsIn(part.rel);
          const env = new Map<string, Bound>();
          part.decl.parameters.forEach((q, i) => {
            if (!ts.isIdentifier(q.name)) return;
            const arg = a[i];
            env.set(q.name.text, arg !== undefined && !ts.isSpreadElement(arg) ? { expr: arg, rel, consts } : { expr: q.initializer, rel: part.rel, consts: pconsts });
          });
          const boundFn = env.get((unwrap(part.functionName) as ts.Identifier).text)?.expr;
          // A helper calling a helper with its own parameter (`(fn) => ch(fn)`): that outer function forwards in turn.
          const fw = boundFn === undefined ? null : forwarding(n, undefined, boundFn);
          if (fw !== null && fw.form === 'positional') forwarder(n, fw.fn);
          else handle(n, part.address, part.abi, part.functionName, part.args, part.noArgs, env, part.rel);
          followed.add(part.decl);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const f of forwarders) {
    if (!followed.has(f.fn)) {
      cannot(
        { file: f.file, line: f.line, ctx: f.ctx },
        `${f.file}:${f.line}: forwards its function's abi / functionName, and the scan followed no call of that function (a callback, or a call through something other than its name): its calls go unchecked.`,
      );
    }
  }
  return { sites, violations, unresolved };
}

function checkSite(where: string, site: Site, abi: Array<{ type: string }>, kinds: readonly Kind[], compiled: Map<Kind, AbiFunction[]>, violations: string[]): void {
  const fnsInAbi = abi.filter((e): e is AbiFunction => e.type === 'function');
  for (const name of site.fns) {
    const byName = fnsInAbi.filter((f) => f.name === name);
    const entries = site.arity === null ? byName : byName.filter((f) => f.inputs.length === site.arity);
    if (entries.length === 0) {
      violations.push(`${where}: ${name}${site.arity === null ? '' : `/${site.arity} args`} is not in the abi it passes (${site.abi}).`);
      continue;
    }
    for (const kind of kinds) {
      const target = compiled.get(kind);
      if (target === undefined) {
        violations.push(`${where}: rule names kind ${kind}, which has no compiled ABI in ops/abis.`);
        continue;
      }
      // Overloads with the same argument count: the call conforms when any of them exists on the kind.
      // Outputs are compared when both sides declare them. The token artifacts (USDG, StockToken) are recovered from
      // deployed dispatch tables and leave a write's outputs empty (inferred, not known), so an empty write output there
      // is no evidence either way.
      const outputsAgree = (f: AbiFunction, g: AbiFunction): boolean =>
        (f.outputs ?? []).length === 0 || ((g.outputs ?? []).length === 0 && g.stateMutability !== 'view' && g.stateMutability !== 'pure') || outsOf(g) === outsOf(f);
      const ok = entries.some((f) => target.some((g) => sigOf(g) === sigOf(f) && outputsAgree(f, g)));
      if (!ok) {
        const sameName = target.filter((g) => g.name === name).map((g) => `${sigOf(g)} returns (${outsOf(g)})`);
        violations.push(
          `${where}: ${entries.map((f) => `${sigOf(f)} returns (${outsOf(f)})`).join(' | ')} [abi ${site.abi}] called on \`${site.address}\`, which can be a ${kind}; ${kind} has ${sameName.length === 0 ? `no ${name}` : sameName.join(', ')}.`,
        );
      }
    }
  }
}

/** Every file under `roots` (files or directories) whose name matches `ext`, minus SKIP and OUT_OF_SCOPE: repo-relative, sorted. */
function filesUnder(roots: readonly string[], ext: RegExp): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    if (!statSync(path.join(repoRoot, rel)).isDirectory()) {
      if (ext.test(rel) && !SKIP.some((s) => s.test(rel)) && !OUT_OF_SCOPE.some((o) => o.file === rel)) out.push(rel);
      return;
    }
    for (const n of readdirSync(path.join(repoRoot, rel))) if (n !== 'node_modules' && n !== '.next' && n !== 'dist') walk(`${rel}/${n}`);
  };
  for (const r of roots) walk(r);
  return out.sort();
}

/** Every scanned source file, repo-relative, sorted. */
const sourceFiles = (): string[] => filesUnder(ROOTS, /\.(ts|tsx|mts)$/);
/** The ops scripts: JavaScript / TypeScript for scan, Python for scanPython. */
const opsFiles = (): string[] => filesUnder(OPS_ROOTS, /\.(m?js|ts)$/);
const opsPythonFiles = (): string[] => filesUnder(OPS_ROOTS, /\.py$/);

/*//////////////////////////////////////////////////////////////
                   PYTHON: cast signature strings
//////////////////////////////////////////////////////////////*/

/**
 * The Python rehearsal harnesses call contracts through `cast call` / `cast send` with a signature
 * string: `cast("call", usdg, "balanceOf(address)(uint256)", who)`, `self.c.read(self.ch, "collateralPerUnit(uint256)(uint256)",
 * lid)`, `self.tx("writer", self.ch, "createSeries(address,bool,uint128,uint40)", ...)`. Every string literal shaped like a
 * signature is a call site: the argument written right before it is the address (classified by the same KIND_RULES),
 * `name(inputs)` is what it encodes, and `(outputs)`, when the call tells cast how to decode, is compared as well. A
 * signature with no address argument right before it (`sig = "..."`) cannot be classified and is unresolved.
 */
export function scanPython(files: readonly string[], read: Reader, rules: readonly KindRule[], compiled: Map<Kind, AbiFunction[]>): ScanResult {
  const sites: Site[] = [];
  const violations: string[] = [];
  const unresolved: Unresolved[] = [];
  for (const rel of files) {
    const text = read(rel);
    if (text === null) continue;
    for (const m of text.matchAll(/(["'])([A-Za-z_]\w*)\(/g)) {
      const quote = m[1]!;
      const start = m.index!;
      // The balanced (inputs), then an optional (outputs), then the closing quote; anything else is not a signature.
      const group = (from: number): number => {
        let depth = 0;
        for (let i = from; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')' && --depth === 0) return i;
          else if (!/[\w[\],]/.test(text[i]!)) return -1;
        }
        return -1;
      };
      const open = start + 1 + m[2]!.length;
      const close = group(open);
      if (close < 0) continue;
      const outClose = text[close + 1] === '(' ? group(close + 1) : close;
      if (outClose < 0 || text[outClose + 1] !== quote) continue;
      const lineStart = text.lastIndexOf('\n', start) + 1;
      if (text.slice(lineStart, start).trimStart().startsWith('#')) continue;
      const name = m[2]!;
      const inputs = text.slice(open + 1, close);
      const outputs = outClose === close ? undefined : text.slice(close + 2, outClose);
      const line = text.slice(0, start).split('\n').length;
      const where = `${rel}:${line}`;
      const ctx = [...text.slice(0, start).matchAll(/^[ \t]*def (\w+)\(/gm)].pop()?.[1] ?? '';
      const sig = `${name}(${inputs})${outputs === undefined ? '' : `(${outputs})`}`;
      const addr = text.slice(Math.max(0, start - 300), start).match(/([A-Za-z_][\w.]*(?:\[[^[\]]*\])*)\s*,\s*$/);
      if (addr === null) {
        const t = `${where}: signature "${sig}" has no address argument right before it, so the test cannot classify what it is sent to.`;
        violations.push(t);
        unresolved.push({ file: rel, line, ctx, text: t });
        continue;
      }
      const fragment = `function ${name}(${inputs})${outputs === undefined ? '' : ` returns (${outputs})`}`;
      let abi: AbiFunction[];
      try {
        abi = parseAbi([fragment]) as unknown as AbiFunction[];
      } catch (e) {
        violations.push(`${where}: signature "${sig}" does not parse as an ABI fragment: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      const site: Site = { file: rel, line, ctx, address: normAddress(addr[1]!), abi: `cast "${sig}"`, fns: [name], arity: abi[0]!.inputs.length, kinds: null, rule: null, checked: false };
      sites.push(site);
      const rule = ruleFor(site, rules);
      if (rule === undefined) {
        violations.push(`${where}: unclassified call site in ${ctx || '<module>'}: address \`${site.address}\`, abi ${site.abi}, function ${name}. Add a KIND_RULES entry naming what this address holds.`);
        continue;
      }
      site.kinds = rule.kinds;
      site.rule = rule;
      if (rule.kinds === EXTERNAL) continue;
      site.checked = true;
      checkSite(where, site, abi, rule.kinds, compiled, violations);
    }
  }
  return { sites, violations, unresolved };
}

/*//////////////////////////////////////////////////////////////
                              TESTS
//////////////////////////////////////////////////////////////*/

const compiled = loadCompiled();
const real = scan(sourceFiles(), diskReader, KIND_RULES, compiled);

test('every keeper / web / indexer contract call exists on every contract kind its address can hold', () => {
  const external = real.sites.filter((s) => s.kinds === EXTERNAL).length;
  console.log(`abi-conformance: ${real.sites.length} call sites, ${real.sites.length - external} checked against ops/abis, ${external} external`);
  assert.deepEqual(real.violations, [], `\n${real.violations.join('\n')}\n`);
});

test('the scan sees the packages it claims to: call sites in the keeper, the web app and the indexer', () => {
  // A scanner that silently parsed nothing would pass the test above. Floors, not pins: they only have to fail
  // when a whole package drops out (a moved root, a SKIP that swallows everything).
  for (const [pkg, floor] of [['keeper/', 150], ['web/', 80], ['indexer/', 30]] as const) {
    const n = real.sites.filter((s) => s.file.startsWith(pkg)).length;
    assert.ok(n >= floor, `${pkg}: ${n} call sites, expected at least ${floor}`);
  }
  // The sites themselves are in scope and classified as either vault kind.
  const askFloors = real.sites.filter((s) => s.file === 'keeper/src/v2/mm/reads.ts' && s.fns.includes('askFloorOf'));
  assert.ok(askFloors.length >= 2);
  for (const s of askFloors) assert.deepEqual(s.kinds, MM_VAULTS);
});

test('every KIND_RULES entry classifies at least one live call site and names only compiled kinds', () => {
  const used = new Set([...real.sites, ...ops.sites].map((s) => s.rule));
  const dead = KIND_RULES.filter((r) => !used.has(r)).map((r) => `${r.file} ${r.address} (${r.why})`);
  assert.deepEqual(dead, [], 'a rule no call site uses can only mis-classify the next one: delete it');
  for (const r of KIND_RULES) if (r.kinds !== EXTERNAL) for (const k of r.kinds) assert.ok(compiled.has(k), `${k} has no ABI in ops/abis`);
});

test('every OUT_OF_SCOPE file exists', () => {
  for (const o of OUT_OF_SCOPE) assert.ok(diskReader(o.file) !== null, `${o.file} is listed out of scope but does not exist`);
});

/*//////////////////////////////////////////////////////////////
               OPS SCRIPTS: monitor and rehearsals
//////////////////////////////////////////////////////////////*/

/**
 * Ops call sites the scan finds but cannot check statically, each with the reason. Matched by file, the
 * enclosing function and a fragment of the scan's message, never by line, so an unrelated edit does not break an entry;
 * an entry that matches nothing fails, so a site that becomes checkable cannot leave a stale excuse behind.
 */
const OPS_UNRESOLVED: ReadonlyArray<{ file: string; ctx: RegExp; match: RegExp; why: string }> = [
  {
    file: 'ops/rehearse-lifecycle/monitor-faults.mjs',
    ctx: /cause/,
    match: /forwards its function's abi \/ functionName, and the scan followed no call/,
    why:
      'storageFlag({ target, fn, abi, ... }) -> ctx.chain.flipTrue(target(ctx), abi, fn): every fault-table entry passes the function as `fn`, ' +
      'the abi as ABI.bool(name) / ABI.boolAddr(name) (a parseAbi template of that same name) and the address as a target(ctx) callback, ' +
      'so the table is not a call the scan can follow. Its entries are the USDG paused / isFrozen and Stock Token paused / oraclePaused flags (monitor-faults.mjs FAULTS)',
  },
  {
    file: 'ops/v2/rehearse/4-drills.mjs',
    ctx: /feedPaused|usdgPaused/,
    match: /cannot resolve abi abi \(ops\/v2\/rehearse\/drill-kit\.mjs\)/,
    why:
      'drill-kit locateFlag(address, fn): the probe abi is parseAbi([`function ${fn}(address...) view returns (bool)`]), built from the very name the caller passes, ' +
      'so it cannot disagree with itself; the name is still checked against the target kind (name only)',
  },
  {
    file: 'ops/rehearse-lifecycle/indexer-web/activity.py',
    ctx: /refresh_feed/,
    match: /signature "latestRoundData\(\)\(uint80,int256,uint256,uint256,uint80\)" has no address argument/,
    why: 'refresh_feed binds the signature to `sig` and reads it from `proxy`, a Chainlink feed proxy: an external contract with no artifact here',
  },
];

/**
 * Ops call sites that resolve and do NOT match ops/abis, accepted with the reason. Matched by file and a
 * fragment of the violation; an entry that matches nothing fails, so the day the reason stops holding (the
 * contracts repo re-exports the ABIs) it has to be deleted.
 */
const OPS_KNOWN_MISMATCH: ReadonlyArray<{ file: string; match: RegExp; why: string }> = [
  {
    file: 'ops/v2/rehearse/1-fork.mjs',
    match: /: (effectiveAt|newUIMultiplier|oraclePaused|uiMultiplier|owner)\(\) returns \(\w+\) \[abi ABI\.token\] called on `t`, which can be a (USDG|StockToken); \2 has no \1\.$/,
    why:
      'the warm-up multicall (aggregate3, allowFailure: true) asks USDG and every Stock Token every view a later step reads, so the fork caches their storage; ' +
      'a view one token kind lacks fails inside the batch by design',
  },
];

const opsJs = scan(opsFiles(), diskReader, KIND_RULES, compiled);
const opsPy = scanPython(opsPythonFiles(), diskReader, KIND_RULES, compiled);
const ops: ScanResult = {
  sites: [...opsJs.sites, ...opsPy.sites],
  violations: [...opsJs.violations, ...opsPy.violations],
  unresolved: [...opsJs.unresolved, ...opsPy.unresolved],
};
const excuseOf = (u: Unresolved): (typeof OPS_UNRESOLVED)[number] | undefined => OPS_UNRESOLVED.find((e) => e.file === u.file && e.ctx.test(u.ctx) && e.match.test(u.text));
const acceptedOf = (v: string): (typeof OPS_KNOWN_MISMATCH)[number] | undefined => OPS_KNOWN_MISMATCH.find((e) => v.startsWith(`${e.file}:`) && e.match.test(v));

test('every monitor / rehearsal / lifecycle contract call exists on every contract kind its address can hold', () => {
  const external = ops.sites.filter((s) => s.kinds === EXTERNAL).length;
  const checked = ops.sites.filter((s) => s.checked).length;
  console.log(
    `abi-conformance (ops): ${ops.sites.length} call sites found (${opsJs.sites.length} JavaScript, ${opsPy.sites.length} Python cast signatures), ` +
      `${checked} checked against ops/abis, ${external} external, ${ops.unresolved.length} unresolved with a reason`,
  );
  for (const u of ops.unresolved) console.log(`  unresolved ${u.file}:${u.line} (${u.ctx || '<module>'}): ${excuseOf(u)?.why ?? 'NO REASON LISTED'}`);
  for (const v of ops.violations.filter((x) => acceptedOf(x) !== undefined)) console.log(`  known mismatch ${v.split(': ')[0]}: ${acceptedOf(v)!.why}`);
  const excused = new Set(ops.unresolved.filter((u) => excuseOf(u) !== undefined).map((u) => u.text));
  const open = ops.violations.filter((v) => !excused.has(v) && acceptedOf(v) === undefined);
  assert.deepEqual(open, [], `\n${open.join('\n')}\n(an unresolved site needs an OPS_UNRESOLVED entry with its reason)\n`);
});

test('every OPS_UNRESOLVED and OPS_KNOWN_MISMATCH entry still names a live call site', () => {
  const stale = [
    ...OPS_UNRESOLVED.filter((e) => !ops.unresolved.some((u) => excuseOf(u) === e)).map((e) => `${e.file} ${e.ctx} ${e.match}`),
    ...OPS_KNOWN_MISMATCH.filter((e) => !ops.violations.some((v) => acceptedOf(v) === e)).map((e) => `${e.file} ${e.match}`),
  ];
  assert.deepEqual(stale, [], 'an excuse nothing needs any more: delete it');
});

test('the ops scan sees what it claims to: the monitor, the rehearsals, the lifecycle rehearsals, and its ABI loaders', () => {
  // Floors, not pins, as for the packages above: they only have to fail when a whole area drops out (a moved file, a
  // resolver that stopped resolving and turned everything into unclassified or unresolved noise).
  const areas: ReadonlyArray<[string, (f: string) => boolean, number]> = [
    ['ops/v2/monitor.mjs', (f) => f === 'ops/v2/monitor.mjs', 60],
    ['ops/v2/rehearse', (f) => f.startsWith('ops/v2/rehearse/'), 120],
    ['ops/rehearse-lifecycle (JavaScript)', (f) => f.startsWith('ops/rehearse-lifecycle/') && !f.endsWith('.py'), 150],
    ['ops/rehearse-lifecycle (Python cast signatures)', (f) => f.startsWith('ops/rehearse-lifecycle/') && f.endsWith('.py'), 25],
  ];
  for (const [label, inArea, floor] of areas) {
    const n = ops.sites.filter((x) => inArea(x.file) && x.checked).length;
    assert.ok(n >= floor, `${label}: ${n} call sites checked, expected at least ${floor}`);
  }
  // The monitor's House vault reads resolve through its parseAbi table and are checked as HouseVault.
  const house = ops.sites.filter((x) => x.file === 'ops/v2/monitor.mjs' && x.address === 'h.address');
  assert.ok(house.length >= 6 && house.every((x) => x.checked && x.kinds !== EXTERNAL && x.kinds?.join() === 'HouseVault'));
  // A loader is a claim about what it reads: its defining line must still be there.
  for (const l of ABI_LOADERS) assert.match(diskReader(l.from) ?? '', l.evidence, `${l.from}: ${l.why}`);
  // So is a hand-off, and the calls made through it are seen: web-txs flows.mjs reads the chain almost only
  // through E, so a resolver that stopped following it would drop them silently.
  for (const o of ENV_OBJECTS) {
    assert.match(diskReader(o.from) ?? '', o.evidence, `${o.from}: ${o.why}`);
    assert.match(diskReader(o.file) ?? '', o.binds, `${o.file}: ${o.why}`);
  }
  const viaEnv = ops.sites.filter((x) => x.file === 'ops/rehearse-lifecycle/web-txs/flows.mjs' && x.checked).length;
  assert.ok(viaEnv >= 40, `web-txs/flows.mjs: ${viaEnv} call sites checked, expected at least 40`);
});

test('ops: a call through a hand-off object (E.rd, E.ABI, `const { ABI } = E`, sender().send) is checked where the object was built', () => {
  const file = 'ops/rehearse-lifecycle/web-txs/flows.mjs';
  const real = diskReader(file) ?? '';
  const broken = real
    .replace('E.rd(E.C.clearinghouse, E.ABI.ch, "mintCutoff"', 'E.rd(E.C.clearinghouse, E.ABI.ch, "mintCutof"')
    .replace('functionName: "replace", args: [orderId, E.parseUnits("0.27", 6), 10n]', 'functionName: "replace", args: [orderId, 10n]')
    .replace('k.send(E.C.clearinghouse, E.ABI.ch, "settle", [se.longId])', 'k.send(E.C.clearinghouse, E.ABI.ob, "settle", [se.longId])');
  assert.notEqual(broken, real);
  const lineOf = (needle: string): number => broken.slice(0, broken.indexOf(needle)).split('\n').length;
  const { violations } = scanOpsFixture({ [file]: broken });
  assert.deepEqual(violations, [
    `${file}:${lineOf('"mintCutof"')}: mintCutof is not in the abi it passes (E.ABI.ch).`,
    `${file}:${lineOf('args: [orderId, 10n]')}: replace/2 args is not in the abi it passes (ABI.ob).`,
    `${file}:${lineOf('E.ABI.ob, "settle"')}: settle/1 args is not in the abi it passes (E.ABI.ob).`,
  ]);
  assert.deepEqual(scanOpsFixture({ [file]: real }).violations, []);
});

/** Scan ops fixture sources: the named files come from `files`, everything they import from the real tree. */
function scanOpsFixture(files: Record<string, string>): ScanResult {
  const read: Reader = (rel) => files[rel] ?? diskReader(rel);
  const names = Object.keys(files);
  const js = scan(names.filter((f) => !f.endsWith('.py')), read, KIND_RULES, compiled);
  const py = scanPython(names.filter((f) => f.endsWith('.py')), read, KIND_RULES, compiled);
  return { sites: [...js.sites, ...py.sites], violations: [...js.violations, ...py.violations], unresolved: [...js.unresolved, ...py.unresolved] };
}

test("ops: the monitor's parseAbi table resolves, and a House vault read through the MakerVault fragments fails (the askFloor case in the monitor)", () => {
  const src = [
    'export const ABI_TEXT = {',
    '  makerVault: ["function askFloor(uint256 longId) view returns (uint256)"],',
    '  houseVault: ["function epochEnd() view returns (uint40)"],',
    '};',
    'export async function runOnce(C, h) {',
    '  const ABI = Object.fromEntries(Object.entries(ABI_TEXT).map(([k, v]) => [k, parseAbi(v)]));',
    '  return readMany([{ address: h.address, abi: ABI.makerVault, functionName: "askFloor", args: [1n] }]);',
    '}',
  ].join('\n');
  const { violations, sites } = scanOpsFixture({ 'ops/v2/monitor.mjs': src });
  assert.equal(sites.length, 1);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0]!, /^ops\/v2\/monitor\.mjs:7: askFloor\(uint256\) returns \(uint256\) \[abi ABI\.makerVault\] called on `h\.address`, which can be a HouseVault; HouseVault has no askFloor\.$/);
  const fixed = src.replace('abi: ABI.makerVault, functionName: "askFloor", args: [1n]', 'abi: ABI.houseVault, functionName: "epochEnd"');
  assert.deepEqual(scanOpsFixture({ 'ops/v2/monitor.mjs': fixed }).violations, []);
});

test('ops: a helper that forwards its own parameter as the function name is checked at each of its callers', () => {
  // ops/v2/rehearse/3-story.mjs: `const ch = (fn, args = []) => read(C.clearinghouse, ABI.clearinghouse, fn, args)`, with
  // read and ABI (abiOf("Clearinghouse")) imported from the real rehearsal lib.
  const src = [
    'import { ABI, read } from "./lib.mjs";',
    'const C = contracts();',
    'const ch = (fn, args = []) => read(C.clearinghouse, ABI.clearinghouse, fn, args);',
    'export async function main() {',
    '  await ch("seriesExists", [1n]);',
    '  await ch("askFloor", [1n]);',
    '}',
  ].join('\n');
  const { violations, sites } = scanOpsFixture({ 'ops/v2/rehearse/fixture-partial.mjs': src });
  assert.deepEqual(sites.map((x) => `${x.line} ${x.address} ${x.fns.join()}/${x.arity}`), ['5 C.clearinghouse seriesExists/1', '6 C.clearinghouse askFloor/1']);
  assert.deepEqual(violations, ['ops/v2/rehearse/fixture-partial.mjs:6: askFloor/1 args is not in the abi it passes (ABI.clearinghouse).']);
});

test('ops: a helper with two sinks is checked at each, against what each is sent to (the askFloor case)', () => {
  // The shape: one helper reads the treasury MakerVault on one branch and a House vault on the other. MakerVault
  // has askFloor; HouseVault does not. Checking the first sink only let the House read pass.
  const src = [
    'const ABI_MV = parseAbi(["function askFloor(uint256) view returns (uint256)"]);',
    'const read = (address, abi, fn, args = []) => pub.readContract({ address, abi, functionName: fn, args });',
    'const floorOf = (v, fn, args) => (v.kind === "treasury" ? read(C.mv, ABI_MV, fn, args) : read(m.house, ABI_MV, fn, args));',
    'export const go = async (v) => floorOf(v, "askFloor", [1n]);',
  ].join('\n');
  const { violations, sites } = scanOpsFixture({ 'ops/rehearse-lifecycle/fixture-two-sinks.mjs': src });
  assert.deepEqual(sites.map((x) => `${x.line} ${x.address} ${x.kinds}`), ['4 C.mv MakerVault', '4 m.house HouseVault']);
  assert.deepEqual(violations, [
    'ops/rehearse-lifecycle/fixture-two-sinks.mjs:4: askFloor(uint256) returns (uint256) [abi ABI_MV (ops/rehearse-lifecycle/fixture-two-sinks.mjs)] called on `m.house`, which can be a HouseVault; HouseVault has no askFloor.',
  ]);
});

test('ops: a Python cast signature is checked, outputs included (the activity.py settlementPrice case)', () => {
  // The earlier line: SettlementOracle.settlementPrice returns (SettlementStatus, uint256), a uint8 status that cast
  // was told to decode as a bool.
  const src = ['def settle(self, m, e):', '    sp = self.c.read(self.so, "settlementPrice(address,uint40)(bool,uint256)", m["asset"], str(e))', ''].join('\n');
  const { violations, sites } = scanOpsFixture({ 'ops/rehearse-lifecycle/indexer-web/fixture.py': src });
  assert.equal(sites.length, 1);
  assert.deepEqual(violations, [
    'ops/rehearse-lifecycle/indexer-web/fixture.py:2: settlementPrice(address,uint40) returns (bool,uint256) [abi cast "settlementPrice(address,uint40)(bool,uint256)"] called on `self.so`, which can be a SettlementOracle; SettlementOracle has settlementPrice(address,uint40) returns (uint8,uint256).',
  ]);
  assert.deepEqual(scanOpsFixture({ 'ops/rehearse-lifecycle/indexer-web/fixture.py': src.replace('(bool,uint256)', '(uint8,uint256)') }).violations, []);
});

test('ops: an object parameter keyed `abi` / `functionName` leaves the callers\' literals as the sites; any other key must be followed', () => {
  const src = [
    'const ABI_CH = parseAbi(["function askFloor(uint256) view returns (uint256)"]);',
    'function send(from, { address, abi, functionName, args = [] }) { return wallet.writeContract({ account: from, address, abi, functionName, args }); }',
    'export const go = () => send(me, { address: C.clearinghouse, abi: ABI_CH, functionName: "askFloor", args: [1n] });',
    'const read = async (to, abi, functionName, args = []) => client.readContract({ address: to, abi, functionName, args });',
    'function flag({ target, fn, abi }) {',
    '  return { cause: (ctx) => read(target(ctx), abi, fn) };',
    '}',
    'export const FAULTS = [flag({ target: () => USDG, fn: "paused", abi: ABI_CH })];',
  ].join('\n');
  const { violations, unresolved } = scanOpsFixture({ 'ops/rehearse-lifecycle/fixture-faults.mjs': src });
  assert.equal(violations.length, 2, violations.join('\n'));
  assert.match(violations[0]!, /^ops\/rehearse-lifecycle\/fixture-faults\.mjs:3: askFloor\(uint256\) .* Clearinghouse has no askFloor\.$/);
  assert.match(violations[1]!, /^ops\/rehearse-lifecycle\/fixture-faults\.mjs:6: forwards its function's abi \/ functionName, and the scan followed no call/);
  assert.deepEqual(unresolved.map((u) => `${u.line} ${u.ctx}`), ['6 cause']);
});

test('ops: a call site whose abi is computed at runtime is reported unresolved, and its function name is still checked', () => {
  const src = [
    'export async function main(C, pick) {',
    '  await read(C.clearinghouse, pick(), "series", [1n]);',
    '  await read(C.clearinghouse, pick(), "askFloor", [1n]);',
    '}',
    'async function read(address, abi, functionName, args) { return pub.readContract({ address, abi, functionName, args }); }',
  ].join('\n');
  const { violations, unresolved } = scanOpsFixture({ 'ops/v2/rehearse/fixture-dynamic.mjs': src });
  assert.deepEqual(unresolved.map((u) => u.line), [2, 3]);
  assert.ok(unresolved.every((u) => / cannot resolve abi pick\(\) /.test(u.text)));
  const nameOnly = violations.filter((v) => !unresolved.some((u) => u.text === v));
  assert.deepEqual(nameOnly, ['ops/v2/rehearse/fixture-dynamic.mjs:3: askFloor called on `C.clearinghouse`, which can be a Clearinghouse; Clearinghouse has no askFloor (checked by name only: the abi is unresolved).']);
});

/*//////////////////////////////////////////////////////////////
                 POSITIVE CONTROLS (fixture sources)
//////////////////////////////////////////////////////////////*/

/** Scan fixture sources: the named files come from `files`, everything they import from the real tree. */
function scanFixture(files: Record<string, string>): ScanResult {
  const read: Reader = (rel) => files[rel] ?? diskReader(rel);
  return scan(Object.keys(files), read, KIND_RULES, compiled);
}

test("the askFloor case by name: MakerVault.askFloor(uint256) read from the mm-bot's vault address fails on HouseVault", () => {
  // The old line from keeper/src/v2/mm/reads.ts readSeriesViews, before the askFloor fix.
  const before = [
    "import { makerVaultAbi } from '../abi/makerVault.js';",
    'export function readSeriesViews(a: MmAddresses, info: SeriesInfo, calls: AnyRead[]) {',
    "  calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'askFloor', args: [info.longId] });",
    '}',
  ].join('\n');
  const { violations } = scanFixture({ 'keeper/src/v2/mm/reads.ts': before });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0]!, /^keeper\/src\/v2\/mm\/reads\.ts:3: askFloor\(uint256\) .* HouseVault has no askFloor\.$/);

  // The fix reads askFloorOf(uint256,bool), which both vault kinds have.
  const after = before.replace("functionName: 'askFloor', args: [info.longId]", "functionName: 'askFloorOf', args: [info.longId, true]");
  assert.deepEqual(scanFixture({ 'keeper/src/v2/mm/reads.ts': after }).violations, []);
});

test('a positional write wrapper is followed: its caller is the call site', () => {
  // web/lib/v2/tx.ts simulatedWrite(context, address, abi, functionName, args); a House vault sent MakerVault.redeem.
  const src = [
    'import { makerVaultAbi } from "../abi/v2/makerVault";',
    'import { simulatedWrite } from "./tx";',
    'export function redeemHouse(context: WriteContext, vault: Address, id: bigint) {',
    '  return simulatedWrite(context, requireHouseVaultAddress(vault), makerVaultAbi, "redeem", [id]);',
    '}',
  ].join('\n');
  const { violations, sites } = scanFixture({ 'web/lib/v2/fixture-wrapper.ts': src });
  assert.equal(sites.length, 1);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0]!, /^web\/lib\/v2\/fixture-wrapper\.ts:4: redeem\(uint256\) .* HouseVault has no redeem\.$/);
});

test('a functionName-only helper is followed, and a spread-built call keeps its abi and address', () => {
  const src = [
    "import { makerVaultAbi } from '../abi/makerVault.js';",
    'export function readVault(a: MmAddresses) {',
    '  const call = (functionName: string) => ({ abi: makerVaultAbi, address: a.vault, functionName });',
    "  const v = { address: a.vault, abi: makerVaultAbi };",
    "  return [call('treasury'), { ...v, functionName: 'withdrawPosition', args: [1n, 2n] }];",
    '}',
  ].join('\n');
  const { violations } = scanFixture({ 'keeper/src/v2/mm/reads.ts': src });
  assert.equal(violations.length, 2, violations.join('\n'));
  assert.match(violations[0]!, /reads\.ts:5: treasury\(\) .* HouseVault has no treasury\.$/);
  assert.match(violations[1]!, /reads\.ts:5: withdrawPosition\(uint256,uint256\) .* HouseVault has no withdrawPosition\.$/);
});

test('a forwarding helper whose calls the scan cannot follow fails instead of vanishing', () => {
  const src = [
    "import { houseVaultAbi } from '../abi/houseVault.js';",
    'export function readVault(a: MmAddresses) {',
    '  const call = (functionName: string) => ({ abi: houseVaultAbi, address: a.vault, functionName });',
    "  return ['nav', 'epochId'].map(call);",
    '}',
  ].join('\n');
  const { violations, sites } = scanFixture({ 'keeper/src/v2/mm/reads.ts': src });
  assert.equal(sites.length, 0);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0]!, /^keeper\/src\/v2\/mm\/reads\.ts:3: forwards its function's abi \/ functionName, and the scan followed no call/);
});

test('a call site no rule classifies fails, naming what to add', () => {
  const src = [
    "import { houseVaultAbi } from './abi/houseVault.js';",
    "export const r = (mystery: Address) => ({ address: mystery, abi: houseVaultAbi, functionName: 'nav' });",
  ].join('\n');
  const { violations } = scanFixture({ 'keeper/src/v2/fixture-unclassified.ts': src });
  assert.deepEqual(violations, [
    'keeper/src/v2/fixture-unclassified.ts:2: unclassified call site in r: address `mystery`, abi houseVaultAbi (ops/abis/v2/HouseVault.json), function nav. Add a KIND_RULES entry naming what this address holds.',
  ]);
});

test('a function name absent from the abi the call passes fails (functionName: string defeats the type check)', () => {
  const src = [
    "import { houseVaultAbi } from '../abi/houseVault.js';",
    "export const r = (a: MmAddresses) => ({ address: a.vault, abi: houseVaultAbi, functionName: 'askFloor', args: [1n] });",
  ].join('\n');
  const { violations } = scanFixture({ 'keeper/src/v2/mm/reads.ts': src });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0]!, /reads\.ts:2: askFloor\/1 args is not in the abi it passes \(houseVaultAbi/);
});
