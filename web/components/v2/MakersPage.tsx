"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAddress } from "viem";
import { useAccount } from "wagmi";

import { Button, CodeBlock, Disclosure, InfoTip, Notice, PageHead, Panel, Stat, Table } from "@/components/ui";
import { Time } from "@/components/ui/Time";
import { RewardClaims } from "@/components/v2/RewardClaims";
import { TableOrCards } from "@/components/v2/RecordCards";
import { addressUrl } from "@/lib/chain";
import { displayMoney, displayPercent, displayQuantity, displayRatioPercent } from "@/lib/numberFormat";
import { v2Api } from "@/lib/v2/api";
import type { ConfigResponse, MakersResponse, Money } from "@/lib/v2/api-types";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { useConfig, useMaker } from "@/lib/v2/hooks";
import { makerProgram } from "@/lib/v2/rewardPrograms";

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** A whole count (units, fills): grouped, compact from 10,000. */
const count = (value: number | string) => displayQuantity(BigInt(value), 0);
const usdg = (money: Money) => `${displayMoney(BigInt(money.raw), money.decimals)} USDG`;
/** The indexer's 0-100 score (ppm / 10,000): at most one decimal, no zero tail. */
const score = (value: number) => displayQuantity(BigInt(Math.round(value * 10_000)), 4, { maxDecimals: 1 });
const bpsPercent = (bps: number) => displayRatioPercent(BigInt(bps), 10_000n);
const spread = (bps: number | null) => bps === null ? "—" : bpsPercent(bps);
const tierShare = (bps: number) => bps ? bpsPercent(bps) : "Default";

const rebateBpsOk = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000;

/**
 * The default fill-rebate share shown on the page. It is OrderBook `FeeParams.makerRebateBps`, which the fee
 * manager can change (`OrderBook.setFeeParams`, at most BPS), so the page reads the LIVE value the indexer
 * serves on /v2/config `fees.makerRebateBps` (the same source LendVault's cost block uses). The generated registry's
 * launch value is only a fallback while /v2/config is loading or unavailable, and it is labelled as such. Null when
 * neither is a usable share.
 */
export function makerRebateShare(live: Pick<ConfigResponse["fees"], "makerRebateBps"> | undefined, registryBps: unknown):
  { bps: number | null; source: "live" | "registry" } {
  if (live !== undefined && rebateBpsOk(live.makerRebateBps)) return { bps: live.makerRebateBps, source: "live" };
  const fallback = registryBps === null || registryBps === undefined || registryBps === "" ? Number.NaN : Number(registryBps);
  return { bps: rebateBpsOk(fallback) ? fallback : null, source: "registry" };
}

/**
 * The page's quoting sample, exported so a test reads the string the page shows. (Measured on a v9
 * fork): the old sample's ask mined but was never listed and could not be filled, because it never approved the order
 * book as the maker's Clearinghouse operator; and its validUntil came from the machine's clock while the book judges
 * block.timestamp. It now does what the app's own ask flow does (EarnMarket listAsk: setOperator when not yet set).
 */
export const makerScript = `import { createWalletClient, http, parseEventLogs, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient, robinhoodChain } from './lib/chain';
import { clearinghouseAbi } from './lib/abi/v2/clearinghouse';
import { orderBookAbi } from './lib/abi/v2/orderBook';
import { V2_DEPLOYMENT } from './lib/v2/config';

// Run locally with environment variables. Never put a signing key in a web page.
const account = privateKeyToAccount(process.env.MAKER_PRIVATE_KEY as \`0x\${string}\`);
const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http() });
const { orderBook, clearinghouse } = V2_DEPLOYMENT.contracts;
if (!orderBook || !clearinghouse) throw new Error('OrderBook or Clearinghouse is not deployed');
const longId = BigInt(process.env.LONG_ID!); // check the series and mint cutoff
const units = 10n; // 0.10 share

// An AskWrite needs BOTH free collateral in the Clearinghouse ledger AND the order book approved as your
// Clearinghouse operator. Without the operator the order still mines, but the book never lists it and no take fills it.
const approved = await publicClient.readContract({ address: clearinghouse, abi: clearinghouseAbi,
  functionName: 'isOperator', args: [account.address, orderBook] });
if (!approved) {
  const hash = await wallet.writeContract({ address: clearinghouse, abi: clearinghouseAbi,
    functionName: 'setOperator', args: [orderBook, true] });
  const set = await publicClient.waitForTransactionReceipt({ hash });
  if (set.status !== 'success') throw new Error('setOperator reverted');
}

// The book judges validUntil against block.timestamp, so count from the latest block, not this machine's clock.
const head = await publicClient.getBlock({ blockTag: 'latest' });
const validUntil = Number(head.timestamp) + 3600; // must precede the mint cutoff
const txHash = await wallet.writeContract({ address: orderBook, abi: orderBookAbi,
  functionName: 'place', args: [longId, 2, parseUnits('0.25', 6), units, validUntil] });
// 2 = AskWrite. Read the new order ID from the confirmed event.
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') throw new Error('Place reverted');
const [placed] = parseEventLogs({ abi: orderBookAbi, logs: receipt.logs, eventName: 'OrderPlaced' });
const orderId = placed?.args.orderId;
if (orderId === undefined) throw new Error('OrderPlaced event missing');
await wallet.writeContract({ address: orderBook, abi: orderBookAbi,
  functionName: 'replace', args: [orderId, parseUnits('0.27', 6), units] });`;

/**
 * The maker program's claims panel. The rendering lives in `RewardClaims`, which is shared
 * with the lender program. The explanation sits in the heading's "?".
 */
function MakerClaims({ epoch }: { epoch: number }) {
  const { address } = useAccount();
  const program = makerProgram(V2_DEPLOYMENT.contracts.rewardsDistributor);
  const profile = useMaker(address);
  const epochs = useMemo(() => [...new Set([epoch, ...(profile.data?.epochs.map((item) => item.epoch.id) ?? [])])]
    .sort((a, b) => b - a).slice(0, 12), [epoch, profile.data]);
  return <RewardClaims program={program} address={address} epochs={epochs}
    heading="Claim rewards"
    tip="A week's rewards become claimable once its reward root is posted on chain."
    unavailable={profile.isError ? <Notice tone="warn">Older epochs are unavailable. The current one is shown.</Notice> : null} />;
}

export function MakersPage() {
  const { address } = useAccount();
  const makers = useInfiniteQuery({ queryKey: ["v2", "maker-list"],
    queryFn: ({ pageParam, signal }) => v2Api.getMakers({ limit: 25, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000, refetchInterval: 15_000 });
  const first = makers.data?.pages[0];
  const items = [...new Map((makers.data?.pages.flatMap((page) => page.items as MakersResponse["items"]) ?? [])
    .map((row) => [row.maker.toLowerCase(), row])).values()];
  const contracts = V2_DEPLOYMENT.contracts;
  const config = useConfig();
  const rebate = makerRebateShare(config.data?.fees, V2_DEPLOYMENT.fees?.makerRebateBps);
  const cell = "min-w-0 px-4 py-4 sm:px-5";
  return <>
    <PageHead title="Market makers" lede="Quote both sides of the book and see each week's scores." />
    <div className="flex flex-col gap-6 pb-6">
    <Panel pad="none" className="grid grid-cols-2 divide-line max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*:nth-child(odd)]:border-r lg:grid-cols-4 lg:divide-x">
      <Stat className={cell} label={<span className="inline-flex items-center gap-1.5">Fill rebate <InfoTip label="About fill rebates" align="start">Your share of
        the taker fee each time your order fills. A maker&apos;s rebate tier can set a different share.</InfoTip></span>}
        value={rebate.bps === null ? "—" : bpsPercent(rebate.bps)}
        sub={rebate.source === "registry" && rebate.bps !== null ? "Launch setting shown; the current rate has not loaded." : "of the taker fee"} />
      <Stat className={cell} mono={false} label={<span className="inline-flex items-center gap-1.5">Rebate tiers <InfoTip label="About rebate tiers">Set per
        maker. No tier means the default share. The book reads a maker&apos;s tier at each fill.</InfoTip></span>} value="Per maker" sub="Default share without one" />
      <Stat className={cell} mono={false} label={<span className="inline-flex items-center gap-1.5">Weekly rewards <InfoTip label="About weekly rewards">USDG
        rewards, in weeks that are funded. Claimable once the week&apos;s reward root is posted on chain.</InfoTip></span>} value="USDG" sub="In funded weeks" />
      <Stat className={cell} label={first ? <span className="inline-flex items-center gap-1.5">Scoring week <InfoTip label="About the scoring week"
        align="end">Epoch {first.epoch.id}: <Time at={first.epoch.start} /> to <Time at={first.epoch.end} />.</InfoTip></span> : "Scoring week"}
        value={first ? `#${first.epoch.id}` : "—"} sub={first ? <>Ends <Time at={first.epoch.end} /></> : "Latest recorded week"} />
    </Panel>
    <Panel as="section" pad="none" aria-labelledby="maker-scores-title" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <h2 id="maker-scores-title" className="flex items-center gap-1.5 text-[17px] font-bold">Scores
          <InfoTip label="About scoring" align="start">Scores weigh two-sided uptime, depth near fair value and tight spreads. Weeks start
            Monday 00:00 UTC. Depth counts orders within 1% of fair value.</InfoTip></h2>
        <Button size="sm" variant="ghost" disabled={makers.isFetching} onClick={() => void makers.refetch()}>Refresh</Button>
      </div>
      {makers.isPending ? <p role="status" className="px-4 py-6 text-sm text-ink-2 sm:px-5">Loading maker scores…</p> : !makers.data
        ? <Notice tone="warn" role="status" className="m-4 sm:m-5">Maker scores are unavailable. <Button size="xs" variant="ghost" onClick={() => void makers.refetch()}>Try again</Button></Notice>
        : <>
          {makers.isError ? <Notice tone="warn" className="m-4 sm:m-5">Showing saved scores while live updates recover.</Notice> : null}
          {items.length === 0 ? <p className="px-4 py-10 text-center text-sm text-ink-2 sm:px-5">No maker scores have been recorded for this week.</p>
            : <TableOrCards cardsLabel="Maker scores for the latest epoch" className="p-4 sm:px-5"
              cards={items.map((row) => ({
                id: row.maker,
                highlighted: address?.toLowerCase() === row.maker.toLowerCase(),
                title: <a className="underline decoration-line-2 underline-offset-2" href={addressUrl(row.maker)}
                  target="_blank" rel="noopener noreferrer" title={row.maker}>{shortAddress(row.maker)}</a>,
                // EVERY column the table carries, none dropped. A figure a phone user cannot see
                // and cannot know about is the defect this code exists to remove, not a fix for it.
                fields: [
                  { label: "Score", value: score(row.score) },
                  { label: "Uptime", value: displayPercent(row.uptimePct) },
                  { label: "Spread", value: spread(row.avgSpreadBps) },
                  { label: "Depth (units)", value: count(row.depthWithin100bps) },
                  { label: "Fills", value: count(row.fills) },
                  { label: "Volume", value: usdg(row.volume) },
                  { label: "Rebates", value: usdg(row.rebates) },
                  { label: "Tier share", value: tierShare(row.tierBps) },
                ],
              }))}>
              <Table label="Maker scores for the latest epoch" minWidth={790} className="px-5 pb-1 pt-2">
              <thead><tr><th>Maker</th><th>Score</th><th>Uptime</th><th>Spread</th><th>Depth (units)</th><th>Fills</th><th>Volume</th><th>Rebates</th><th>Tier share</th></tr></thead>
              <tbody>{items.map((row) => <tr key={row.maker} className={address?.toLowerCase() === row.maker.toLowerCase() ? "bg-accent-soft" : ""}>
                <td><a className="underline decoration-line-2 underline-offset-2" href={addressUrl(row.maker)} target="_blank" rel="noopener noreferrer" title={row.maker}>{shortAddress(row.maker)}</a></td>
                <td>{score(row.score)}</td><td>{displayPercent(row.uptimePct)}</td><td>{spread(row.avgSpreadBps)}</td>
                <td>{count(row.depthWithin100bps)}</td><td>{count(row.fills)}</td><td>{usdg(row.volume)}</td><td>{usdg(row.rebates)}</td>
                <td>{tierShare(row.tierBps)}</td>
              </tr>)}</tbody>
              </Table>
            </TableOrCards>}
          {makers.hasNextPage ? <Button size="sm" variant="ghost" className="mx-4 mb-4 sm:mx-5" disabled={makers.isFetchingNextPage}
            onClick={() => void makers.fetchNextPage()}>{makers.isFetchingNextPage ? "Loading…" : "Load more makers"}</Button> : null}
        </>}
    </Panel>
    {first ? <div className="[&>section]:mt-0"><MakerClaims epoch={first.epoch.id} /></div> : null}
    <div className="flex flex-col gap-3">
      <Disclosure title="Contracts" summary="OrderBook, MakerVault, MakerRegistry and RewardsDistributor addresses">
        <div className="grid">{(["orderBook", "makerVault", "makerRegistry", "rewardsDistributor"] as const).map((name) =>
          <div key={name} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2.5 first:border-0 first:pt-0">
            <span className="font-semibold text-ink">{({ orderBook: "OrderBook", makerVault: "MakerVault", makerRegistry: "MakerRegistry", rewardsDistributor: "RewardsDistributor" })[name]}</span>
            {contracts[name] ? <a className="num break-all text-sm text-accent-text underline" href={addressUrl(getAddress(contracts[name]))} target="_blank" rel="noopener noreferrer">{contracts[name]}</a>
              : <span className="text-sm text-ink-2">Awaiting deployment</span>}</div>)}</div>
      </Disclosure>
      <Disclosure title="Quote from a script" summary="Place and replace an ask with viem and the OrderBook ABI">
        <p>Check the series, your collateral, the price tick and the mint cutoff first. An ask that writes
          (AskWrite) needs free collateral in the Clearinghouse and the order book approved as your Clearinghouse operator; the
          sample sets the operator first.</p>
        <CodeBlock><code>{makerScript}</code></CodeBlock>
      </Disclosure>
    </div>
    </div>
  </>;
}
