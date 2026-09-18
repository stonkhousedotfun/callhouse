"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { formatUnits, getAddress, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, CodeBlock, Notice, PageHead, Panel, Table } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { v2Api } from "@/lib/v2/api";
import type { MakersResponse } from "@/lib/v2/api-types";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { useMaker } from "@/lib/v2/hooks";
import { claimMakerReward, parseMakerEpochFile, readMakerClaim } from "@/lib/v2/makerRewards";

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

function ClaimForEpoch({ epoch, account, distributor }: { epoch: number; account: Address; distributor: Address }) {
  const wallet = useWalletClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const file = useQuery({ queryKey: ["maker-epoch-file", epoch], queryFn: async () => {
    const response = await fetch(`/maker-epochs/${epoch}.json`, { cache: "no-store" });
    if (response.status === 404) return null; // operator has not published a root for this epoch
    if (!response.ok) throw new Error("Reward file could not be loaded.");
    return parseMakerEpochFile(await response.json(), epoch);
  }, staleTime: 60_000, refetchInterval: 60_000, retry: 0 });
  const claim = useQuery({ queryKey: ["maker-claim", epoch, account, file.data?.root, distributor],
    enabled: Boolean(file.data), queryFn: () => readMakerClaim(distributor, file.data!, account),
    staleTime: 15_000, retry: 0 });
  if (file.isPending) return <p className="text-sm text-ink-2">Epoch {epoch}: checking published rewards…</p>;
  if (file.isError) return <Notice tone="warn" role="status">Epoch {epoch}: {file.error.message}
    <Button size="xs" variant="ghost" className="ml-2" disabled={file.isFetching}
      onClick={() => void file.refetch()}>{file.isFetching ? "Retrying…" : "Try again"}</Button>
  </Notice>;
  if (!file.data) return <p className="text-sm text-ink-2">Epoch {epoch}: no reward file published yet.</p>;
  if (claim.isPending) return <p className="text-sm text-ink-2">Epoch {epoch}: checking the chain…</p>;
  if (claim.isError) return <Notice tone="warn" role="status">Epoch {epoch}: {claim.error.message}
    <Button size="xs" variant="ghost" className="ml-2" disabled={claim.isFetching}
      onClick={() => void claim.refetch()}>{claim.isFetching ? "Retrying…" : "Try again"}</Button>
  </Notice>;
  const reward = claim.data;
  if (!reward || reward.status === "no-reward") return <p className="text-sm text-ink-2">Epoch {epoch}: no reward for this wallet.</p>;
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-0">
    <p className="text-sm"><span className="font-semibold">Epoch {epoch}</span> · {formatUnits(BigInt(reward.entry!.amount), 6)} USDG
      {reward.status === "claimed" ? <span className="ml-2 text-ink-2">Claimed</span> : null}</p>
    {reward.status === "ready" ? <Button size="sm" disabled={pending || !wallet.data} onClick={async () => {
      if (!wallet.data || !file.data || !reward.entry) return;
      setPending(true);
      try {
        notice("pending", "Confirm maker reward", "Review the USDG claim in your wallet.");
        await claimMakerReward(wallet.data as WalletClient, account, distributor, file.data, reward.entry);
        await client.invalidateQueries({ queryKey: ["maker-claim", epoch, account] });
        notice("success", "Reward claimed", "USDG was sent to your wallet.");
      } catch (error) {
        if (!unknownReceipt(error))
          notice("error", "Claim stopped", error instanceof Error ? error.message : "The claim could not be completed.");
      } finally { setPending(false); }
    }}>{pending ? "Claiming…" : "Claim USDG"}</Button> : null}
  </div>;
}

function MakerClaims({ epoch }: { epoch: number }) {
  const { address } = useAccount();
  const distributor = V2_DEPLOYMENT.contracts.rewardsDistributor;
  const profile = useMaker(address);
  const epochs = useMemo(() => [...new Set([epoch, ...(profile.data?.epochs.map((item) => item.epoch.id) ?? [])])]
    .sort((a, b) => b - a).slice(0, 12), [epoch, profile.data]);
  return <Panel as="section" id="maker-rewards" className="mt-6">
    <h2 className="font-display text-xl font-bold">Claim epoch rewards</h2>
    <p className="mt-2 text-sm text-ink-2">The operator publishes a reward file after an epoch and posts its root on chain. The app checks your proof against that root before asking your wallet to claim.</p>
    {!address ? <div className="mt-4"><ConnectButton /></div> : !distributor
      ? <Notice tone="info" className="mt-4">Reward claims will open after the RewardsDistributor is deployed.</Notice>
      : <div className="mt-4 space-y-2">{profile.isError ? <Notice tone="warn">Older maker epochs are unavailable right now. The current epoch is still shown.</Notice> : null}
        {epochs.map((id) => <ClaimForEpoch key={`${address}-${id}`} epoch={id} account={address} distributor={distributor} />)}</div>}
  </Panel>;
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
      <p className="mt-2 text-sm text-ink-2">Each week starts Monday at 00:00 UTC. The indexer samples eligible makers with quotes near fair value; stale pricing does not count as maker downtime. The score combines two-sided quote uptime (40%), depth near fair value (30%), tighter spreads (20%), and filled volume (10%).</p>
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
            : <Table label="Maker scores for the latest epoch" className="mt-5" minWidth={790}>
              <thead><tr><th>Maker</th><th>Score</th><th>Uptime</th><th>Spread</th><th>Depth (units)</th><th>Fills</th><th>Volume</th><th>Rebates</th><th>Tier share</th></tr></thead>
              <tbody>{items.map((row) => <tr key={row.maker} className={address?.toLowerCase() === row.maker.toLowerCase() ? "bg-accent-soft" : ""}>
                <td><a className="underline decoration-line-2 underline-offset-2" href={addressUrl(row.maker)} target="_blank" rel="noopener noreferrer" title={row.maker}>{shortAddress(row.maker)}</a></td>
                <td>{row.score.toFixed(1)}</td><td>{row.uptimePct.toFixed(1)}%</td><td>{row.avgSpreadBps === null ? "—" : `${row.avgSpreadBps} bps`}</td>
                <td>{number(row.depthWithin100bps)}</td><td>{number(row.fills)}</td><td>{row.volume.formatted} USDG</td><td>{row.rebates.formatted} USDG</td>
                <td>{row.tierBps ? `${row.tierBps / 100}%` : "Default"}</td>
              </tr>)}</tbody>
            </Table>}
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
