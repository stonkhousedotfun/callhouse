/**
 * Part 2: every v2 user flow the app wires, driven through the app's OWN transaction helpers, on an anvil fork
 * of Robinhood Chain 4663, from a plain wallet that holds nothing but what this run gives it.
 *
 * WHY THROUGH THE APP'S HELPERS. The claim button that shipped (houseTx.ts claimHouseOwed, since removed) built
 * correct calldata for a function no user may call. Only the app's own code shows what the app sends: so each flow
 * calls the same exported helper the page calls (lib/v2/tx.ts, houseTx.ts, lendTx.ts, zapTx.ts, earnTx.ts; the Lend
 * deposit makes the two helper calls LendVault.tsx:228-229 submitLendDeposit makes, because importing that component
 * pulls wallet-icon UI packages a script cannot load),
 * against the addresses the app resolves from its generated registry (lib/v2/config.ts requireV2Address,
 * lib/markets.generated.ts). Each helper simulates with eth_call first (simulatedWrite); on the fork the write is then
 * really sent, so the next step of a flow (an approval, a deposit, a placed order) runs against the state the first left.
 *
 * THE WALLET. A fresh address, impersonated on anvil so eth_sendTransaction from it is accepted, given fork-only ETH for gas,
 * USDG and the NVDA Stock Token by transfer from a recent large holder of each (found in the token's Transfer logs). It holds no
 * role and no position the chain did not give it in this run.
 *
 * EACH ROW records the flow, the call the helper tried (contract address and function, taken from the simulateContract
 * request), the registry key it came from, and the outcome: `ok` (mined), a decoded revert (error name and args), or
 * the app's own refusal before any chain call. `userState` says whether a revert is a legitimate refusal of THIS
 * wallet's state (nothing to claim, no shares) or a wiring defect (a role check, a wrong address).
 *
 * RUN (from web/):
 *   anvil --fork-url <an archive RPC for 4663> --chain-id 4663 --port 8549 --silent
 *   WIRING_RPC=http://127.0.0.1:8549 pnpm exec tsx --tsconfig tests/acceptance/tsconfig.json tests/acceptance/wiring.fork.ts
 * It refuses anything that is not anvil on chain 4663, and writes nothing outside the fork. WIRING_OUT=<file> also
 * writes the rows as JSON.
 *
 * EXIT STATUS. Nonzero when any row is a role refusal OR an unclassified revert (a revert whose name is in
 * neither list below, or that did not decode); the last stderr line names both kinds. Zero means every revert was a
 * recognised refusal of this wallet's state. WIRING_SELFTEST=1 runs only the summary's self-check, with no RPC.
 */
import { writeFileSync } from "node:fs";

import {
  BaseError,
  encodeAbiParameters,
  keccak256,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";

const RPC = process.env.WIRING_RPC ?? "http://127.0.0.1:8549";
// Before any app module is imported: lib/chain.ts reads these at import time.
process.env.NEXT_PUBLIC_RPC_URL = RPC;
process.env.NEXT_PUBLIC_RPC_URL_2 = RPC;

/* ---------------------------------------------------------------- classification ---------------------------------- */

type Row = {
  flow: string;
  helper: string;
  call: string | null;
  address: Address | null;
  source: string;
  outcome: "ok" | "revert" | "app-refused";
  detail: string;
  userState: boolean | null;
};

/** Errors that refuse the CALLER, whatever its state: a manager role (AccessManaged*) or an in-contract caller check. */
const ROLE = /^(AccessManaged|NotAuthorized|Unauthorized|OnlyQuoter|NotQuoter|OwnableUnauthorized|NotOwner|NotVault|OnlyVault)/;
/** Errors that refuse THIS wallet's state, not the wiring: nothing owed, no shares, no position, a closed window. */
const USER_STATE = /^(ERC1155InsufficientBalance|BadUnits|Nothing|NoShares|NoPosition|NoRequest|NotPending|Insufficient|ZeroAmount|ZeroShares|BelowMin|NotHolder|NotFinal|NotSettled|NotExpired|TooEarly|ERC20InsufficientBalance|ERC4626|NoClaim|AlreadyClaimed|InvalidProof|EmptyQueue|QueueEmpty|NoDeposit|NoWithdraw|Epoch|Window|Closed|Paused)/;

/**
 * A revert's `userState`: false for a role refusal (a wiring defect), true for a refusal of this wallet's state, null
 * when the name is in neither list or the revert did not decode. Null is NOT a pass: see `summarize`.
 */
function classify(name: string | null): boolean | null {
  if (name === null) return null;
  return ROLE.test(name) ? false : USER_STATE.test(name) ? true : null;
}

/**
 * The run's verdict. A role refusal is a defect. So is an UNCLASSIFIED revert (outcome `revert`, userState null): a
 * caller check whose name neither list knows (an `OnlyKeeper`) or a revert that did not decode is exactly what this
 * audit exists to see, and counting only the ROLE list let one pass as silence. Both are named in the line and both
 * make the run exit nonzero; the operator either fixes the wiring or adds the name to the right list.
 */
function summarize(rows: readonly Row[]): { line: string; failing: number } {
  const refusals = rows.filter((r) => r.userState === false);
  const unclassified = rows.filter((r) => r.outcome === "revert" && r.userState === null);
  const name = (list: readonly Row[]) => list.map((r) => `${r.flow}: ${r.detail}`).join("; ") || "none";
  const ok = rows.filter((r) => r.outcome === "ok").length;
  return {
    line: `wiring.fork: ${rows.length} rows, ${ok} ok, ${refusals.length} role refusals: ${name(refusals)}; ${unclassified.length} unclassified reverts: ${name(unclassified)}`,
    failing: refusals.length + unclassified.length,
  };
}

/**
 * The summary's own positive control, run before any RPC: an unlisted caller check, a listed role error, an undecoded
 * revert, a user-state refusal and a mined call. A summary that stopped naming either kind of defect fails here, loudly,
 * instead of reporting a clean run. `WIRING_SELFTEST=1` runs only this and exits.
 */
function selfCheck(): void {
  const row = (flow: string, outcome: Row["outcome"], detail: string, name: string | null): Row =>
    ({ flow, helper: "self-check", call: null, address: null, source: "self-check", outcome, detail, userState: outcome === "revert" ? classify(name) : null });
  const rows = [
    row("unlisted", "revert", "OnlyKeeper()", "OnlyKeeper"),
    row("role", "revert", "AccessManagedUnauthorized(0x7e57)", "AccessManagedUnauthorized"),
    row("undecoded", "revert", "execution reverted", null),
    row("wallet", "revert", "NoShares()", "NoShares"),
    row("mined", "ok", "mined", null),
  ];
  const expect = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`wiring.fork self-check: ${what}`);
  };
  expect(classify("OnlyKeeper") === null, "an unlisted error name must classify as null (unclassified)");
  expect(classify("AccessManagedUnauthorized") === false && classify("NoShares") === true, "the ROLE / USER_STATE lists changed meaning");
  const { line, failing } = summarize(rows);
  expect(failing === 3, `3 failing rows expected (unlisted, role, undecoded), got ${failing}: ${line}`);
  expect(line.includes("1 role refusals: role: AccessManagedUnauthorized(0x7e57)"), `the role refusal is not named: ${line}`);
  expect(line.includes("2 unclassified reverts: unlisted: OnlyKeeper(); undecoded: execution reverted"), `the unclassified reverts are not named: ${line}`);
  expect(!line.includes("NoShares") && !line.includes("mined:"), `a wallet-state refusal or a mined call was counted as a defect: ${line}`);
}

// The web package compiles tsx scripts as CommonJS, which has no top-level await: the run is main(). It resolves to the
// number of failing rows (role refusals + unclassified reverts).
async function main(): Promise<number> {
  selfCheck();
  if (process.env.WIRING_SELFTEST === "1") {
    console.error("wiring.fork: self-check ok (WIRING_SELFTEST=1: no RPC touched)");
    return 0;
  }
  const probe = createPublicClient({ transport: http(RPC) });
  const [chainId, clientVersion] = await Promise.all([probe.getChainId(), probe.request({ method: "web3_clientVersion" }) as Promise<string>]);
  if (chainId !== 4663 || !/anvil/i.test(clientVersion)) {
    throw new Error(`wiring.fork: refusing ${RPC}: chain ${chainId}, client ${clientVersion}. Only an anvil fork of 4663.`);
  }

  const { robinhoodChain } = await import("../../lib/chain");
  const { GENERATED_MARKETS: MARKETS } = await import("../../lib/markets.generated");
  const { USDG } = await import("../../lib/contracts");
  const { requireV2Address, resolveV2Address } = await import("../../lib/v2/config");
  const tx = await import("../../lib/v2/tx");
  const house = await import("../../lib/v2/houseTx");
  const lend = await import("../../lib/v2/lendTx");
  const zap = await import("../../lib/v2/zapTx");
  const earn = await import("../../lib/v2/earnTx");
  const reward = await import("../../lib/v2/rewardClaim");
  const { orderBookAbi } = await import("../../lib/abi/v2/orderBook");
  const { settlementOracleAbi } = await import("../../lib/abi/v2/settlementOracle");
  const { earnVaultAbi } = await import("../../lib/abi/v2/earnVault");
  const { houseVaultAbi } = await import("../../lib/abi/v2/houseVault");
  const { clearinghouseAbi } = await import("../../lib/abi/v2/clearinghouse");
  const { expiryCalendarAbi } = await import("../../lib/abi/v2/expiryCalendar");

  const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC) }) as PublicClient;
  const block = await client.getBlock({ blockTag: "latest" });

  /* ---------------------------------------------------------------- the wallet ------------------------------------ */

  // 4663 is an Orbit chain with a 2^50 block gas limit, and anvil bounds gas estimation by balance / gas price: a
  // realistic balance makes every estimate fail "exceeds the balance". Fork-only ETH, so it is set very high.
  const GAS_BALANCE = "0xc9f2c9cd04674edea40000000";
  const user = `0x${"7e57".repeat(10)}` as Address;
  const anvil = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never });
  await anvil("anvil_impersonateAccount", [user]);
  await anvil("anvil_setBalance", [user, GAS_BALANCE]);
  const wallet = createWalletClient({ account: user, chain: robinhoodChain, transport: http(RPC) });

  const nvda = MARKETS.find((m) => m.ticker === "NVDA")!;
  const NVDA = nvda.asset as Address;
  const HOUSE_NVDA = nvda.v2.houseVault as Address;
  const clearinghouse = requireV2Address("clearinghouse");
  const orderBook = requireV2Address("orderBook");

  /** Transfer logs of `token` ending at `head`, over the widest recent window the RPC will answer. */
  async function recentTransfers(token: Address, head: bigint) {
    // The upstream RPC caps eth_getLogs at 10,000 results, and USDG passes that inside 4,000 blocks (measured
    // 2026-09-23: the run died here before its first flow). Narrow the window until the answer fits.
    for (let span = 4_000n; ; span /= 4n) {
      try {
        return await client.getLogs({ address: token, event: erc20Abi.find((e) => e.type === "event" && e.name === "Transfer")!, fromBlock: head - span, toBlock: head });
      } catch (error) {
        const detail = error instanceof BaseError ? error.details : String(error);
        if (span <= 62n || !/exceeds limit/i.test(detail)) throw error;
      }
    }
  }
  /**
   * Funding: the largest recipient of the token in its recent Transfer logs that still holds `amount` gives it, by an
   * impersonated transfer. Found, not typed, so the run does not depend on one address keeping its balance; a transfer
   * that does not mine successfully stops the run (a flow judged on an unfunded wallet would be judged wrongly).
   */
  async function fund(token: Address, amount: bigint): Promise<Address> {
    const head = await client.getBlockNumber();
    const logs = await recentTransfers(token, head);
    // The recipients of the 50 largest transfers, not every recipient: USDG's window holds hundreds, and a balanceOf for
    // each, all at once through the fork, timed out upstream. A large holder shows up among large transfers.
    const byValue = [...logs].sort((x, y) => ((y.args as { value: bigint }).value > (x.args as { value: bigint }).value ? 1 : -1));
    const candidates = [...new Set(byValue.map((l) => (l.args as { to: Address }).to))].filter((a) => a.toLowerCase() !== user.toLowerCase()).slice(0, 50);
    const balances = await Promise.all(candidates.map((a) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] })));
    const best = candidates.map((a, i) => ({ a, b: balances[i]! })).filter((x) => x.b >= amount).sort((x, y) => (y.b > x.b ? 1 : -1))[0];
    if (best === undefined) throw new Error(`wiring.fork: no recent holder of ${token} with ${amount}`);
    await anvil("anvil_impersonateAccount", [best.a]);
    await anvil("anvil_setBalance", [best.a, GAS_BALANCE]);
    const from = createWalletClient({ account: best.a, chain: robinhoodChain, transport: http(RPC) });
    const hash = await from.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [user, amount] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`wiring.fork: funding transfer of ${token} from ${best.a} reverted`);
    return best.a;
  }
  const funders = { usdg: await fund(USDG, parseUnits("5000", 6)), nvda: await fund(NVDA, parseUnits("5", 18)) };

  /* ---------------------------------------------------------------- recording ------------------------------------- */

  const rows: Row[] = [];
  let lastCall: { address: Address; functionName: string } | null = null;
  // Read through a function: the Proxy below assigns lastCall inside a closure, which TypeScript's narrowing cannot see.
  const seen = (): { address: Address; functionName: string } | null => lastCall;

  // The helpers take `context.client`; this one notes the request before simulating it, so a row names the call the app
  // built even when the simulation reverts.
  const recordingClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "simulateContract") {
        return (args: { address: Address; functionName: string }) => {
          lastCall = { address: args.address, functionName: args.functionName };
          return target.simulateContract(args as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PublicClient;
  const context = { account: user, wallet, client: recordingClient };

  function decode(error: unknown): { detail: string; revert: boolean; name: string | null } {
    for (let e: unknown = error; e !== undefined && e !== null; e = (e as { cause?: unknown }).cause) {
      if (e instanceof BaseError) {
        const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
        if (reverted !== null) {
          const name = reverted.data?.errorName ?? reverted.signature ?? reverted.reason ?? "revert";
          const args = reverted.data?.args?.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ") ?? "";
          return { detail: `${name}(${args})`, revert: true, name };
        }
        if (e instanceof ContractFunctionExecutionError) return { detail: e.shortMessage, revert: true, name: null };
      }
    }
    return { detail: error instanceof Error ? error.message : String(error), revert: false, name: null };
  }

  async function step(flow: string, helper: string, source: string, run: () => Promise<unknown>): Promise<boolean> {
    lastCall = null;
    try {
      await run();
      rows.push({ flow, helper, call: seen()?.functionName ?? null, address: seen()?.address ?? null, source, outcome: "ok", detail: "mined", userState: null });
      return true;
    } catch (error) {
      const d = decode(error);
      const outcome = d.revert ? "revert" : seen() === null ? "app-refused" : "revert";
      rows.push({
        flow, helper, call: seen()?.functionName ?? null, address: seen()?.address ?? null, source, outcome, detail: d.detail,
        userState: outcome === "revert" ? classify(d.name) : null,
      });
      return false;
    }
  }

  /* ---------------------------------------------------------------- the flows ------------------------------------- */

  const now = Number(block.timestamp);

  // 1. Collateral in the Clearinghouse ledger (the write path's first step: EarnMarket.tsx approves, then deposits).
  await step("collateral deposit", "tx.approveExact", "registry:clearinghouse", () => tx.approveExact(context, NVDA, clearinghouse, parseUnits("2", 18)));
  await step("collateral deposit", "tx.deposit", "registry:clearinghouse", () => tx.deposit(context, NVDA, parseUnits("2", 18)));

  // 2. Buy a call. A live ask a quoting vault rests on NVDA is taken the way TradeTicket.tsx:222-223 takes it. When no vault
  // is quoting (the fork block may be outside the MM's hours), a second plain wallet makes one through the same app
  // helpers a writer uses (EarnMarket.tsx: create the series if absent, approve and deposit collateral, place an
  // AskWrite), and the user takes that.
  const makers = [requireV2Address("makerVault"), HOUSE_NVDA];
  type Ask = { id: bigint; longId: bigint; price: bigint; remaining: bigint; maker: Address };
  const liveAsk = async (candidates: readonly Address[]): Promise<Ask | null> => {
    const t = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    for (const maker of candidates) {
      const [ids] = await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: "ordersOfMaker", args: [maker, 0n, 200n] });
      if (ids.length === 0) continue;
      const orders = await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: "getOrders", args: [ids] });
      const i = orders.findIndex((o) => o.kind !== 0 && !o.cancelled && o.units > o.filled && Number(o.validUntil) > t);
      if (i >= 0) return { id: ids[i]!, longId: orders[i]!.longId, price: orders[i]!.price, remaining: orders[i]!.units - orders[i]!.filled, maker };
    }
    return null;
  };
  let ask = await liveAsk(makers);
  let askSource = "a quoting vault's live ask";
  if (ask === null) {
    askSource = "an ask written by a second plain wallet through the app's helpers (no vault was quoting at the fork block)";
    const writer = `0x${"3a17".repeat(10)}` as Address;
    await anvil("anvil_impersonateAccount", [writer]);
    await anvil("anvil_setBalance", [writer, GAS_BALANCE]);
    const funder = createWalletClient({ account: funders.nvda, chain: robinhoodChain, transport: http(RPC) });
    await client.waitForTransactionReceipt({ hash: await funder.writeContract({ address: NVDA, abi: erc20Abi, functionName: "transfer", args: [writer, parseUnits("2", 18)] }) });
    const writerContext = { account: writer, wallet: createWalletClient({ account: writer, chain: robinhoodChain, transport: http(RPC) }), client: recordingClient };
    const calendar = requireV2Address("expiryCalendar");
    let expiry = Number(await client.readContract({ address: calendar, abi: expiryCalendarAbi, functionName: "nextExpiry", args: [now, false] }));
    if (expiry - 1800 <= now + 600) expiry = Number(await client.readContract({ address: calendar, abi: expiryCalendarAbi, functionName: "nextExpiry", args: [expiry + 1, false] }));
    const [, spot] = await client.readContract({ address: requireV2Address("settlementOracle"), abi: settlementOracleAbi, functionName: "trySpot", args: [NVDA] });
    const { strikeTick } = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [NVDA] });
    const tick = BigInt(strikeTick);
    const strike = ((spot * 105n) / 100n / tick + 1n) * tick;
    const longId = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "longIdOf", args: [NVDA, false, strike, expiry] });
    // EarnMarket.tsx:428-432: operator first, then the series if absent, then the AskWrite.
    await step("write (operator)", "tx.setOperator", "registry:clearinghouse", () => tx.setOperator(writerContext, orderBook, true));
    if (!(await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "seriesExists", args: [longId] }))) {
      await step("Earn: create a series", "earn.createSeries", "registry:clearinghouse", () => earn.createSeries(writerContext, NVDA, false, strike, expiry));
    }
    await step("write (collateral)", "tx.approveExact", "registry:clearinghouse", () => tx.approveExact(writerContext, NVDA, clearinghouse, parseUnits("2", 18)));
    await step("write (collateral)", "tx.deposit", "registry:clearinghouse", () => tx.deposit(writerContext, NVDA, parseUnits("2", 18)));
    await step("sell (write an ask)", "tx.place", "registry:orderBook", () => tx.place(writerContext, longId, 2, 1_000_000n, 10n, now + 3600));
    ask = await liveAsk([writer]);
  }
  let boughtLongId: bigint | null = null;
  if (ask === null) {
    rows.push({ flow: "buy a call", helper: "tx.take", call: "take", address: orderBook, source: "registry:orderBook", outcome: "app-refused", detail: `no live ask to take (${askSource})`, userState: null });
  } else {
    const a = ask;
    const request = { longId: a.longId, buying: true, orderIds: [a.id], units: 1n, minUnits: 1n, limitPrice: a.price, writeToSell: false, recipient: user };
    let quote: { filled: bigint; premium: bigint; takerFee: bigint; sellerFees: bigint } | null = null;
    // The quote TradeTicket shows before it approves (a read; recorded so a refusal here is a row, not a crash).
    // quoteTake is simulated from the taker (not a view; no `from` reverts NotAuthorized).
    await step("buy a call (quote)", "orderBook.quoteTake (simulate)", "registry:orderBook", async () => {
      const { result: [filled, premium, takerFee, sellerFees] } = await client.simulateContract({ account: user, address: orderBook, abi: orderBookAbi, functionName: "quoteTake",
        args: [{ ...request, deadline: now + 300, maxTotalFee: (1n << 128n) - 1n }] });
      quote = { filled, premium, takerFee, sellerFees };
    });
    if (quote !== null) {
      const q = quote as { filled: bigint; premium: bigint; takerFee: bigint; sellerFees: bigint };
      await step("buy a call", "tx.approveExact", "registry:orderBook", () => tx.approveExact(context, USDG, orderBook, q.premium + q.takerFee));
      const ok = await step("buy a call", "tx.recheckTakeQuote + tx.take", `registry:orderBook (${askSource})`, async () =>
        tx.take(context, await tx.recheckTakeQuote(context, request, q)));
      if (ok) boughtLongId = a.longId;
    }
  }

  // 3. Resell what was bought (an AskResale), then replace and cancel it (Portfolio.tsx's order management).
  let placedId: bigint | null = null;
  if (boughtLongId !== null) {
    // Portfolio.tsx:198: the long tokens the book escrows need its ERC-1155 approval first.
    await step("sell (resale ask)", "tx.setTokenApproval", "registry:clearinghouse", () => tx.setTokenApproval(context, orderBook, true));
    const placed = await step("sell (resale ask)", "tx.place", "registry:orderBook", () => tx.place(context, boughtLongId!, 1, 1_500_000n, 1n, now + 3600));
    if (placed) {
      const [ids] = await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: "ordersOfMaker", args: [user, 0n, 10n] });
      placedId = ids.at(-1) ?? null;
    }
  }
  if (placedId !== null) {
    await step("manage an order", "tx.replace", "registry:orderBook", () => tx.replace(context, placedId!, 1_600_000n, 1n));
    await step("manage an order", "tx.cancel", "registry:orderBook", () => tx.cancel(context, [placedId!]));
  }

  // 4. Clearinghouse account settings and the ledger withdrawal.
  await step("payout settings", "tx.setPayoutInKind", "registry:clearinghouse", () => tx.setPayoutInKind(context, true));
  await step("payout settings", "tx.setPayoutToLedger", "registry:clearinghouse", () => tx.setPayoutToLedger(context, true));
  await step("operator", "tx.setOperator", "registry:clearinghouse", () => tx.setOperator(context, requireV2Address("autoRoller"), true));
  await step("token approval", "tx.setTokenApproval", "registry:clearinghouse", () => tx.setTokenApproval(context, orderBook, true));
  await step("collateral withdraw", "tx.withdraw", "registry:clearinghouse", () => tx.withdraw(context, NVDA, parseUnits("0.1", 18)));
  if (boughtLongId !== null) {
    await step("close a position", "tx.close", "registry:clearinghouse", () => tx.close(context, boughtLongId!, 1n));
    await step("redeem", "tx.redeem", "registry:clearinghouse", () => tx.redeem(context, boughtLongId!));
  }

  // 5. The House vault page (HouseVault.tsx): deposit, cancel it, withdraw and claim. The Claim-owed button is gone.
  const houseSource = "registry:markets[NVDA].v2.houseVault";
  await step("House deposit", "house.requestHouseDeposit", houseSource, () => house.requestHouseDeposit(context, HOUSE_NVDA, USDG, parseUnits("100", 6)));
  await step("House cancel deposit", "house.cancelHouseDepositRequest", houseSource, () => house.cancelHouseDepositRequest(context, HOUSE_NVDA));
  await step("House deposit (again, kept)", "house.requestHouseDeposit", houseSource, () => house.requestHouseDeposit(context, HOUSE_NVDA, USDG, parseUnits("100", 6)));
  const shares = await client.readContract({ address: HOUSE_NVDA, abi: houseVaultAbi, functionName: "balanceOf", args: [user] });
  await step("House withdraw", "house.requestHouseWithdraw", houseSource, () => house.requestHouseWithdraw(context, HOUSE_NVDA, shares > 0n ? shares : 1n));
  await step("House cancel withdraw", "house.cancelHouseWithdrawRequest", houseSource, () => house.cancelHouseWithdrawRequest(context, HOUSE_NVDA));
  await step("House claim", "house.claimHouseWithdrawal", houseSource, () => house.claimHouseWithdrawal(context, HOUSE_NVDA));
  // A change removed the Claim-owed button and its helper: HouseVault.claimOwed() is QUOTER-only, so every
  // click reverted NotAuthorized() for every depositor. The flow stays in the table with no call, and the run refuses
  // if the helper comes back.
  if ("claimHouseOwed" in house) throw new Error("houseTx.ts exports claimHouseOwed again: HouseVault.claimOwed() is QUOTER-only (T-OP-291)");
  rows.push({ flow: "House claim owed", helper: "(none)", call: null, address: null, source: houseSource, outcome: "app-refused", detail: "no helper: removed by T-OP-291, claimOwed() is QUOTER-only", userState: null });

  // 6. Lend (LendVault.tsx): deposit through the page's own submitLendDeposit, redeem, process the queue.
  const earnVault = resolveV2Address("earnVault");
  if (earnVault.address === null) {
    rows.push({ flow: "Lend", helper: "lendTx", call: null, address: null, source: "registry:earnVault", outcome: "app-refused", detail: "earnVault not configured in this build", userState: null });
  } else {
    const lendSource = `${earnVault.source}:earnVault`;
    // LendVault.tsx:228-229 submitLendDeposit: approveExact(USDG -> vault), then the deposit the page passes in
    // (LendVault.tsx:400: depositToVaultTracked, the same EarnVault.deposit write plus its queue id).
    await step("Lend deposit", "tx.approveExact", lendSource, () => tx.approveExact(context, USDG, earnVault.address!, parseUnits("100", 6)));
    await step("Lend deposit", "lend.depositToVaultTracked", lendSource, () => lend.depositToVaultTracked(context, parseUnits("100", 6)));
    const lendShares = await client.readContract({ address: earnVault.address, abi: earnVaultAbi, functionName: "balanceOf", args: [user] });
    await step("Lend redeem", "lend.redeemFromVault", lendSource, () => lend.redeemFromVault(context, lendShares > 0n ? lendShares / 2n || 1n : 1n));
    await step("Lend process queue", "lend.processVaultQueue", lendSource, () => lend.processVaultQueue(context, 8n));
  }

  // 7. Zap (EarnMarket.tsx:397/414): USDG into the Stock Token and back, at the oracle's spot.
  const zapAddress = resolveV2Address("stockZap");
  if (zapAddress.address === null) {
    rows.push({ flow: "zap", helper: "zapTx", call: null, address: null, source: "registry:stockZap", outcome: "app-refused", detail: "stockZap not configured in this build", userState: null });
  } else {
    const [spotOk, spot] = await client.readContract({ address: requireV2Address("settlementOracle"), abi: settlementOracleAbi, functionName: "trySpot", args: [NVDA] });
    const zapSource = `${zapAddress.source}:stockZap`;
    await step("zap in", "tx.approveExact", zapSource, () => tx.approveExact(context, USDG, zapAddress.address!, parseUnits("50", 6)));
    await step("zap in", "zap.writeZap", zapSource, () => zap.writeZap(context, NVDA, parseUnits("50", 6), spotOk ? spot : null, 6, 18));
    await step("zap out", "tx.approveExact", zapSource, () => tx.approveExact(context, NVDA, zapAddress.address!, parseUnits("0.05", 18)));
    await step("zap out", "zap.exitZap", zapSource, () => zap.exitZap(context, NVDA, parseUnits("0.05", 18), spotOk ? spot : null, 6, 18));
  }

  // 8. Earn, the writer's AutoRoller strategy (EarnMarket.tsx): delegate, set, stop.
  const roller = requireV2Address("autoRoller");
  await step("Earn delegate", "earn.setDelegate", "registry:orderBook", () => earn.setDelegate(context, roller, true));
  await step("Earn strategy", "earn.setStrategy", "registry:autoRoller", () => earn.setStrategy(context, NVDA, {
    active: true, weekly: false, smartPricing: false, otmBps: 500, askBps: 100, minAskBps: 50, maxAskBps: 300, maxUnits: "100",
  }));
  await step("Earn stop", "earn.stopStrategy", "registry:autoRoller", () => earn.stopStrategy(context, NVDA));

  // 9. A series the writer names that does not exist yet (EarnMarket.tsx:429 createSeries), on its own strike.
  {
    const calendar = requireV2Address("expiryCalendar");
    const expiry = Number(await client.readContract({ address: calendar, abi: expiryCalendarAbi, functionName: "nextExpiry", args: [now + 86_400, false] }));
    const [, spot] = await client.readContract({ address: requireV2Address("settlementOracle"), abi: settlementOracleAbi, functionName: "trySpot", args: [NVDA] });
    const { strikeTick } = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [NVDA] });
    const strike = ((spot * 125n) / 100n / BigInt(strikeTick) + 1n) * BigInt(strikeTick);
    await step("Earn: create a series", "earn.createSeries", "registry:clearinghouse", () => earn.createSeries(context, NVDA, false, strike, expiry));
  }

  // 10. Rewards claim (rewardClaim.ts claimReward). A plain wallet has no published reward, so this checks the app's own
  // gate on the right distributor: a self-consistent single-leaf epoch file for this wallet, which the app must refuse
  // because the on-chain root(epoch) of the distributor it resolves is not that file's root.
  {
    const distributor = requireV2Address("rewardsDistributor");
    const epoch = 999_999;
    const entry = { index: 0, account: user, amount: "1", proof: [] as `0x${string}`[] };
    const inner = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(epoch), 0n, user, 1n]));
    const file = { epoch, root: keccak256(inner), total: "1", entries: [entry] };
    await step("rewards claim", "reward.claimReward", "registry:rewardsDistributor", () => reward.claimReward(wallet, user, distributor, file, entry));
    rows.at(-1)!.address = distributor;
  }

  /* ---------------------------------------------------------------- report ---------------------------------------- */

  const report = { rpc: RPC.replace(/\/\/[^/]*@/, "//"), forkBlock: block.number.toString(), forkBlockTime: now, wallet: user, funders, rows };
  console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  if (process.env.WIRING_OUT !== undefined) writeFileSync(process.env.WIRING_OUT, JSON.stringify(report, null, 1));
  const { line, failing } = summarize(rows);
  console.error(line);
  return failing;
}

main().then(
  (failing) => {
    if (failing > 0) process.exitCode = 1;
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
