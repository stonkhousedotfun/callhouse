"use client";

import { useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount, useBlock, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useTxRunner } from "@/components/TxToast";
import { Button, Notice, Panel, TickerLogo } from "@/components/ui";
import { CHAIN_ID } from "@/lib/chain";
import { USDG, ZERO_ADDRESS, accountFactoryAbi, stockTokenAbi, writerAccountAbi } from "@/lib/contracts";
import { Time } from "@/components/ui/Time";
import { fmtAsset, fmtUsdg } from "@/lib/format";
import { LEGACY_MARKETS, migrationStep, type LegacyMarket } from "@/lib/legacy";
import { isV2Live } from "@/lib/markets";

function AccountJourney({ market }: { market: LegacyMarket }) {
  const { address, chainId } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const notice = useNotice();
  const [busy, setBusy] = useState(false);
  const factory = useReadContract({ address: market.factory, abi: accountFactoryAbi, functionName: "accountOf",
    args: address ? [address] : undefined, query: { enabled: Boolean(address) } });
  const account = typeof factory.data === "string" && factory.data !== ZERO_ADDRESS ? factory.data as Address : undefined;
  const enabled = Boolean(account);
  const expiry = useReadContract({ address: account, abi: writerAccountAbi, functionName: "listedExpiryTs", query: { enabled } });
  const idle = useReadContract({ address: account, abi: writerAccountAbi, functionName: "idleAssets", query: { enabled } });
  const reserved = useReadContract({ address: account, abi: writerAccountAbi, functionName: "reserved", query: { enabled } });
  const claimKey = useReadContract({ address: account, abi: writerAccountAbi, functionName: "claimKey", query: { enabled } });
  const usdg = useReadContract({ address: USDG, abi: stockTokenAbi, functionName: "balanceOf",
    args: account ? [account] : undefined, query: { enabled } });
  const walletStock = useReadContract({ address: market.asset, abi: stockTokenAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: Boolean(address) } });
  const block = useBlock({ chainId: CHAIN_ID, query: { enabled, refetchInterval: 15_000 } });
  const isLoading = enabled && [expiry, idle, reserved, claimKey, usdg].some((read) => !read.isSuccess);
  const hasError = [factory, expiry, idle, reserved, claimKey, usdg].some((read) => read.isError);
  const state = { listedExpiry: BigInt(expiry.data ?? 0), chainNow: block.data?.timestamp ?? null,
    usdg: usdg.data ?? 0n, idle: idle.data ?? 0n, claimKey: claimKey.data ?? 0n };
  const step = migrationStep(state);
  const v2Ready = isV2Live(market.ticker);
  // A v1 writer continues on Sell options (/sell), which was /earn before Earn became the lending vault.
  const sellPath = `/sell/${market.ticker.toLowerCase()}`;

  async function act(functionName: "settle" | "claimUsdg" | "withdraw") {
    if (!account || !address || !client || chainId !== CHAIN_ID || busy) return;
    setBusy(true);
    try {
      const amount = functionName === "withdraw" ? idle.data ?? 0n : 0n;
      if (functionName === "withdraw" && amount === 0n) throw new Error("Nothing to withdraw.");
      const args = functionName === "withdraw" ? [amount] : [];
      // Simulate the current account state before the wallet opens. The v1 account is the authority.
      const { request } = await client.simulateContract({ account: address, address: account,
        abi: writerAccountAbi as unknown as Abi, functionName, args });
      const labels = functionName === "settle" ? { pending: "Settle v1 week", success: "V1 week settled" }
        : functionName === "claimUsdg" ? { pending: "Claim v1 USDG", success: "V1 USDG claimed" }
          : { pending: "Withdraw v1 Stock Tokens", success: "Idle Stock Tokens withdrawn" };
      const hash = await run(() => writeContractAsync({ ...request, chainId: CHAIN_ID }), labels);
      if (hash) await Promise.all([expiry.refetch(), idle.refetch(), reserved.refetch(), claimKey.refetch(), usdg.refetch(), walletStock.refetch()]);
    } catch (error) {
      notice("error", "Migration step stopped", error instanceof Error ? error.message : "The chain read failed.");
    } finally { setBusy(false); }
  }

  if (!address) return null;
  if (factory.isPending) return <Panel><p role="status">Checking {market.ticker} v1 account…</p></Panel>;
  if (hasError) return <Panel><p role="alert">Could not read the {market.ticker} v1 account.</p>
    <Button className="mt-3" variant="ghost" size="sm" onClick={() => void factory.refetch()}>Retry</Button></Panel>;
  if (!account) return <Panel><h2 className="font-display text-xl font-bold">{market.ticker}</h2>
    <p className="mt-2 text-sm text-ink-2">No v1 account for this wallet.</p></Panel>;
  if (isLoading) return <Panel><p role="status">Loading {market.ticker} v1 account…</p></Panel>;

  return <Panel as="section" aria-label={`${market.ticker} v1 migration`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 font-display text-xl font-bold"><TickerLogo ticker={market.ticker} />{market.ticker} v1 account</h2>
      <p className="num mt-1 break-all text-xs text-ink-3">{account}</p></div>
      <Button href={`/legacy/${market.ticker.toLowerCase()}/account`} size="sm" variant="ghost">Open old account</Button></div>
    <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-ink-3">Free</dt><dd className="num font-semibold">{fmtAsset(state.idle)} {market.ticker}</dd></div>
      <div><dt className="text-ink-3">Reserved</dt><dd className="num font-semibold">{fmtAsset(reserved.data ?? 0n)} {market.ticker}</dd></div>
      <div><dt className="text-ink-3">USDG</dt><dd className="num font-semibold">{fmtUsdg(state.usdg)} USDG</dd></div>
    </dl>
    <ol className="mt-6 space-y-4 border-t border-line pt-5 text-sm">
      <li><strong>1. Wait for the week to end.</strong> {state.listedExpiry > 0n
        ? <>Expiry: <Time at={Number(state.listedExpiry)} market />.</>
        : "No open week."}</li>
      <li><strong>2. Settle.</strong>
        {step === "settle" ? <Button className="ml-3" size="sm" disabled={busy || chainId !== CHAIN_ID}
          onClick={() => void act("settle")}>Settle v1 week</Button> : null}</li>
      <li><strong>3. Claim USDG.</strong>
        {state.listedExpiry === 0n && state.usdg > 0n ? <Button className="ml-3" size="sm" disabled={busy || chainId !== CHAIN_ID}
          onClick={() => void act("claimUsdg")}>Claim {fmtUsdg(state.usdg)} USDG</Button> : null}</li>
      <li><strong>4. Withdraw your {market.ticker}.</strong>
        {state.listedExpiry === 0n && state.idle > 0n ? <Button className="ml-3" size="sm" disabled={busy || chainId !== CHAIN_ID}
          onClick={() => void act("withdraw")}>Withdraw {fmtAsset(state.idle)} {market.ticker}</Button> : null}</li>
      <li><strong>5. Deposit into v2.</strong>
        {v2Ready ? <Button className="ml-3" href={sellPath} size="sm" variant="ghost">Open Sell options</Button>
          : <span className="ml-2 text-warn">Not live in v2 yet.</span>}</li>
      <li><strong>6. Pick a preset.</strong>
        {v2Ready ? <Button className="ml-3" href={sellPath} size="sm" variant="ghost">See writer presets</Button> : null}</li>
    </ol>
    {state.claimKey > 0n && state.listedExpiry === 0n ? <Notice tone="danger" className="mt-5" title="Some collateral is stuck.">Settle could not
      close the option claim, and v1 has no retry. Withdrawing won&apos;t recover it. Contact support.</Notice> : null}
    {step === "deposit" && (walletStock.data ?? 0n) > 0n && v2Ready ? <Notice tone="info" className="mt-5">Your wallet holds {fmtAsset(walletStock.data ?? 0n)} {market.ticker}, ready for v2.</Notice> : null}
  </Panel>;
}

export function MigrationGuide() {
  const { address, chainId } = useAccount();
  return <div className="mt-7 space-y-4">
    {!address ? <Panel><h2 className="font-display text-xl font-bold">Find your v1 account</h2>
      <p className="mt-2 text-sm text-ink-2">Connect the wallet that owns it.</p>
      <div className="mt-4"><ConnectButton /></div></Panel>
      : chainId !== CHAIN_ID ? <Notice tone="warn">Switch to Robinhood Chain. <ConnectButton /></Notice>
        : LEGACY_MARKETS.length ? LEGACY_MARKETS.map((market) => <AccountJourney key={market.ticker} market={market} />)
          : <Notice tone="info">No v1 markets in this build.</Notice>}
  </div>;
}
