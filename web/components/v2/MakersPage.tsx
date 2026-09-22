"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAddress } from "viem";
import { useAccount } from "wagmi";

import { Button, CodeBlock, Notice, PageHead, Panel, Table } from "@/components/ui";
import { RewardClaims } from "@/components/v2/RewardClaims";
import { TableOrCards } from "@/components/v2/RecordCards";
import { addressUrl } from "@/lib/chain";
import { v2Api } from "@/lib/v2/api";
import type { MakersResponse } from "@/lib/v2/api-types";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { useMaker } from "@/lib/v2/hooks";
import { makerProgram } from "@/lib/v2/rewardPrograms";

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const date = (unix: number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })
  .format(new Date(unix * 1000));
const number = (value: number | string) => new Intl.NumberFormat("en-US").format(typeof value === "string" ? BigInt(value) : value);

const script = `import { createWalletClient, http, parseEventLogs, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient, robinhoodChain } from './lib/chain';
import { orderBookAbi } from './lib/abi/v2/orderBook';
import { V2_DEPLOYMENT } from './lib/v2/config';

// Run locally with environment variables. Never put a signing key in a web page.
const account = privateKeyToAccount(process.env.MAKER_PRIVATE_KEY as \`0x\${string}\`);
const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http() });
const orderBook = V2_DEPLOYMENT.contracts.orderBook;
if (!orderBook) throw new Error('OrderBook is not deployed');
const longId = BigInt(process.env.LONG_ID!); // check the series and mint cutoff
const units = 10n; // 0.10 share; AskWrite needs free collateral in the ledger
const validUntil = Math.floor(Date.now() / 1000) + 3600; // must precede cutoff
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
 * The maker program's claims panel. T-133 moved the rendering into `RewardClaims`, which is shared
 * with the lender program; every string below is the one this page rendered before the extraction.
 */
function MakerClaims({ epoch }: { epoch: number }) {
  const { address } = useAccount();
  const program = makerProgram(V2_DEPLOYMENT.contracts.rewardsDistributor);
  const profile = useMaker(address);
  const epochs = useMemo(() => [...new Set([epoch, ...(profile.data?.epochs.map((item) => item.epoch.id) ?? [])])]
    .sort((a, b) => b - a).slice(0, 12), [epoch, profile.data]);
  return <RewardClaims program={program} address={address} epochs={epochs}
    heading="Claim epoch rewards"
    lede="The operator publishes a reward file after an epoch and posts its root on chain. The app checks your proof against that root before asking your wallet to claim."
    unavailable={profile.isError ? <Notice tone="warn">Older maker epochs are unavailable right now. The current epoch is still shown.</Notice> : null} />;
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
  return <>
    <PageHead eyebrow="Liquidity" title="Market makers" lede="Quote both sides of the book and see the public score for each weekly epoch." />
    <div className="grid gap-4 md:grid-cols-3">
      <Panel><h2 className="font-display text-lg font-bold">Fill rebates</h2><p className="mt-2 text-sm text-ink-2">A resting maker order can earn a share of the taker fee when it fills. The default share is {Number(V2_DEPLOYMENT.fees?.makerRebateBps ?? 0) / 100}%; a registry tier may change it.</p></Panel>
      <Panel><h2 className="font-display text-lg font-bold">Registry tiers</h2><p className="mt-2 text-sm text-ink-2">The book reads each maker&apos;s tier at fill time. An unset tier uses the book default; a tier does not guarantee a fill.</p></Panel>
      <Panel><h2 className="font-display text-lg font-bold">Epoch rewards</h2><p className="mt-2 text-sm text-ink-2">The operator may fund weekly USDG rewards. A published allocation becomes claimable only when its Merkle root is posted to the RewardsDistributor.</p></Panel>
    </div>
    <Panel as="section" className="mt-6">
      <h2 className="font-display text-xl font-bold">How scoring works</h2>
      <p className="mt-2 text-sm text-ink-2">Each week starts Monday at 00:00 UTC. The indexer samples eligible makers with quotes near fair value; stale pricing does not count as maker downtime. The score combines two-sided quote uptime, depth near fair value, and tighter spreads, each with a published weight; the weights are part of the epoch&apos;s scoring policy and change with it.</p>
      <p className="mt-2 text-sm text-ink-2">Depth is measured within 100 basis points of fair value. Rebates and score are separate: a fill may earn a rebate even if the week has no published reward budget.</p>
    </Panel>
    <Panel as="section" className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-bold">Public epoch table</h2>
        <p className="mt-1 text-sm text-ink-2">{first ? `Epoch ${first.epoch.id} · ${date(first.epoch.start)}–${date(first.epoch.end)} UTC` : "Latest recorded week"}</p></div>
        <Button size="sm" variant="ghost" disabled={makers.isFetching} onClick={() => void makers.refetch()}>Refresh</Button></div>
      {makers.isPending ? <p role="status" className="mt-4 text-sm text-ink-2">Loading maker scores…</p> : !makers.data
        ? <Notice tone="warn" role="status" className="mt-4">Maker scores are unavailable. <Button size="xs" variant="ghost" onClick={() => void makers.refetch()}>Try again</Button></Notice>
        : <>
          {makers.isError ? <Notice tone="warn" className="mt-4">Showing saved scores while live updates recover.</Notice> : null}
          {items.length === 0 ? <p className="mt-4 text-sm text-ink-2">No maker scores have been recorded for this week.</p>
            : <TableOrCards cardsLabel="Maker scores for the latest epoch" className="mt-5"
              cards={items.map((row) => ({
                id: row.maker,
                highlighted: address?.toLowerCase() === row.maker.toLowerCase(),
                title: <a className="underline decoration-line-2 underline-offset-2" href={addressUrl(row.maker)}
                  target="_blank" rel="noopener noreferrer" title={row.maker}>{shortAddress(row.maker)}</a>,
                // EVERY column the table carries, none dropped. A figure a phone user cannot see
                // and cannot know about is the defect this row exists to remove, not a fix for it.
                fields: [
                  { label: "Score", value: row.score.toFixed(1) },
                  { label: "Uptime", value: `${row.uptimePct.toFixed(1)}%` },
                  { label: "Spread", value: row.avgSpreadBps === null ? "—" : `${row.avgSpreadBps} bps` },
                  { label: "Depth (units)", value: number(row.depthWithin100bps) },
                  { label: "Fills", value: number(row.fills) },
                  { label: "Volume", value: `${row.volume.formatted} USDG` },
                  { label: "Rebates", value: `${row.rebates.formatted} USDG` },
                  { label: "Tier share", value: row.tierBps ? `${row.tierBps / 100}%` : "Default" },
                ],
              }))}>
              <Table label="Maker scores for the latest epoch" minWidth={790}>
              <thead><tr><th>Maker</th><th>Score</th><th>Uptime</th><th>Spread</th><th>Depth (units)</th><th>Fills</th><th>Volume</th><th>Rebates</th><th>Tier share</th></tr></thead>
              <tbody>{items.map((row) => <tr key={row.maker} className={address?.toLowerCase() === row.maker.toLowerCase() ? "bg-accent-soft" : ""}>
                <td><a className="underline decoration-line-2 underline-offset-2" href={addressUrl(row.maker)} target="_blank" rel="noopener noreferrer" title={row.maker}>{shortAddress(row.maker)}</a></td>
                <td>{row.score.toFixed(1)}</td><td>{row.uptimePct.toFixed(1)}%</td><td>{row.avgSpreadBps === null ? "—" : `${row.avgSpreadBps} bps`}</td>
                <td>{number(row.depthWithin100bps)}</td><td>{number(row.fills)}</td><td>{row.volume.formatted} USDG</td><td>{row.rebates.formatted} USDG</td>
                <td>{row.tierBps ? `${row.tierBps / 100}%` : "Default"}</td>
              </tr>)}</tbody>
              </Table>
            </TableOrCards>}
          {makers.hasNextPage ? <Button size="sm" variant="ghost" className="mt-5" disabled={makers.isFetchingNextPage}
            onClick={() => void makers.fetchNextPage()}>{makers.isFetchingNextPage ? "Loading…" : "Load more makers"}</Button> : null}
        </>}
    </Panel>
    {first ? <MakerClaims epoch={first.epoch.id} /> : null}
    <Panel as="section" className="mt-6"><h2 className="font-display text-xl font-bold">Contracts</h2>
      <div className="mt-4 space-y-3">{(["orderBook", "makerVault", "makerRegistry", "rewardsDistributor"] as const).map((name) =>
        <div key={name} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 first:border-0">
          <span className="font-semibold">{({ orderBook: "OrderBook", makerVault: "MakerVault", makerRegistry: "MakerRegistry", rewardsDistributor: "RewardsDistributor" })[name]}</span>
          {contracts[name] ? <a className="num break-all text-sm text-accent-text underline" href={addressUrl(getAddress(contracts[name]))} target="_blank" rel="noopener noreferrer">{contracts[name]}</a>
            : <span className="text-sm text-ink-2">Awaiting deployment</span>}</div>)}</div>
    </Panel>
    <Panel as="section" className="mt-6"><h2 className="font-display text-xl font-bold">Quote from a script</h2>
      <p className="mt-2 text-sm text-ink-2">Use the generated OrderBook ABI with viem. Check the series, your ledger collateral, the price tick, and the mint cutoff before placing or replacing an ask.</p>
      <CodeBlock className="mt-4"><code>{script}</code></CodeBlock>
    </Panel>
  </>;
}
