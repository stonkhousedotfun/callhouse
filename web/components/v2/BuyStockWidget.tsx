"use client";

/**
 * Buy the market's Stock Token into the connected wallet when the wallet holds none of it.
 *
 * SHOWN ONLY AT A ZERO BALANCE. With no wallet, an unread balance, or any stock already held, this renders
 * nothing. A wallet that holds the stock does not get a buy prompt pushed at it (
 *
 *
 * The user picks ETH or USDG and an amount. The widget shows the quoted output, the route, the price impact
 * and the minimum out, then swaps through the Uniswap UniversalRouter to the WALLET (lib/v2/stockSwap.ts).
 * StockZap is not used here: it credits the Clearinghouse ledger, which is for writing calls.
 *
 * Confirm is disabled while there is no quote, while the quote is refused (price impact above
 * MAX_PRICE_IMPACT_BPS), when the amount is more than the wallet holds, and while a swap is in flight.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, InfoTip, Notice, Panel, SegmentedControl } from "@/components/ui";
import { parseAmount } from "@/lib/format";
import { getV2Market } from "@/lib/markets";
import { displayMoney, displayPercent, displayQuantity } from "@/lib/numberFormat";
import {
  DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, PAY_DECIMALS, PAY_TOKENS, STOCK_DECIMALS,
  clampSlippageBps, executeStockBuy, quoteStockBuy, readBuyBalances, type BuyBalances, type PayToken,
} from "@/lib/v2/stockSwap";

export const stockSwapKeys = {
  balances: (stock: Address | null, account: Address | undefined) => ["stockSwap", "balances", stock, account] as const,
  quote: (stock: Address, payToken: PayToken, amountIn: string, slippageBps: number) =>
    ["stockSwap", "quote", stock, payToken, amountIn, slippageBps] as const,
};

// shown amounts follow lib/numberFormat.ts, so no zero tails ("2 ETH", "0.5%", "1.25 NVDA").
const bpsPercent = (bps: number) => displayPercent(bps / 100);
/** A pay-token balance: ETH to four decimals, USDG as money; "—" until the balance is read (as formatAmount did). */
const payText = (raw: bigint | null | undefined, token: PayToken) => raw === null || raw === undefined ? "—"
  : token === "ETH" ? displayQuantity(raw, PAY_DECIMALS.ETH, { maxDecimals: 4 }) : displayMoney(raw, PAY_DECIMALS.USDG);
const stockText = (raw: bigint) => displayQuantity(raw, STOCK_DECIMALS, { maxDecimals: 4 });

export function BuyStockWidget({ ticker, stock: stockProp, className, initialAmount = "" }: {
  ticker: string;
  /** The market's Stock Token when the page already has it; otherwise the registry row for `ticker`. Null shows nothing. */
  stock?: Address | null;
  className?: string;
  /** Prefill for the amount field, in the pay token's units. */
  initialAmount?: string;
}) {
  const stock = stockProp === undefined ? getV2Market(ticker)?.asset ?? null : stockProp;
  const { address } = useAccount();
  const balances = useQuery({
    queryKey: stockSwapKeys.balances(stock, address),
    queryFn: () => readBuyBalances(stock!, address!),
    enabled: stock !== null && !!address,
    refetchInterval: 30_000,
  });
  if (!stock || !address || !balances.data || balances.data.stock > 0n) return null;
  return <BuyStockForm ticker={ticker} stock={stock} account={address} balances={balances.data}
    className={className} initialAmount={initialAmount} />;
}

function BuyStockForm({ ticker, stock, account, balances, className, initialAmount }: {
  ticker: string; stock: Address; account: Address; balances: BuyBalances; className?: string; initialAmount: string;
}) {
  const wallet = useWalletClient();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const [payToken, setPayToken] = useState<PayToken>("ETH");
  const [amount, setAmount] = useState(initialAmount);
  const [slippage, setSlippage] = useState((DEFAULT_SLIPPAGE_BPS / 100).toString());
  const [busy, setBusy] = useState(false);

  const amountIn = parseAmount(amount, PAY_DECIMALS[payToken]);
  const slippageBps = clampSlippageBps(Number(slippage) * 100);
  const payBalance = payToken === "ETH" ? balances.eth : balances.usdg;
  const overBalance = amountIn !== null && amountIn > payBalance;
  const quote = useQuery({
    queryKey: stockSwapKeys.quote(stock, payToken, amountIn?.toString() ?? "", slippageBps),
    queryFn: () => quoteStockBuy({ payToken, stock, symbol: ticker, amountIn: amountIn!, slippageBps }),
    enabled: amountIn !== null && amountIn > 0n,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const q = amountIn !== null && amountIn > 0n ? quote.data : undefined;
  const canConfirm = !!q && q.refused === null && !overBalance && !busy && !!wallet.data;

  async function buy() {
    if (!q || !wallet.data) return;
    const label = `Buy ${ticker} with ${payToken}`;
    setBusy(true);
    try {
      notice("pending", label, payToken === "USDG"
        ? "Confirm up to three steps in your wallet."
        : "Confirm the swap in your wallet.");
      await executeStockBuy({
        account, wallet: wallet.data,
        onConfirmed: async () => { await queryClient.invalidateQueries({ queryKey: ["stockSwap", "balances"] }); },
      }, q);
      notice("success", label, `${ticker} is in your wallet.`);
      setAmount("");
    } catch (error) {
      if (!unknownReceipt(error)) notice("error", `${label} stopped`, error instanceof Error ? error.message : "Try again after refreshing.");
    } finally { setBusy(false); }
  }

  return <Panel as="section" pad="sm" aria-label={`Buy ${ticker}`} data-slot="buy-stock" className={className}>
    <h2 className="flex items-center gap-1.5 text-[15px] font-bold">
      You hold no {ticker}
      <InfoTip label="About this swap">Swaps on Uniswap straight to your wallet, and reverts if you would get less than the minimum. Gas is extra.</InfoTip>
    </h2>
    <p className="mt-1 text-[13px] text-ink-3">Buy it with ETH or USDG.</p>

    <SegmentedControl label="Pay with" className="mt-3" selected={payToken}
      options={PAY_TOKENS.map((t) => ({ value: t, label: t }))} onSelect={(t) => { setPayToken(t); setAmount(""); }} />

    <label htmlFor={`buy-${ticker}-amount`} className="mt-3 block text-sm font-semibold">Pay ({payToken})</label>
    <input id={`buy-${ticker}-amount`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}
      placeholder={payToken === "ETH" ? "0.1" : "100"} className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
    <p className="mt-1 text-xs text-ink-3">Wallet: {payText(payBalance, payToken)} {payToken}</p>

    <label htmlFor={`buy-${ticker}-slippage`} className="mt-3 block text-sm font-semibold">Slippage (%, max {MAX_SLIPPAGE_BPS / 100})</label>
    <input id={`buy-${ticker}-slippage`} inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value)}
      className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />

    {overBalance ? <Notice tone="warn" role="status" className="mt-3">That is more {payToken} than this wallet holds.</Notice> : null}
    {amountIn !== null && amountIn > 0n && quote.isError ? <Notice tone="warn" role="status" className="mt-3">
      {quote.error instanceof Error ? quote.error.message : "No quote right now. Try again in a moment."}</Notice> : null}

    {q ? <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]" data-slot="buy-quote">
      <dt className="text-ink-3">You get about</dt><dd className="num text-right font-bold">{stockText(q.amountOut)} {ticker}</dd>
      <dt className="text-ink-3">Minimum out</dt><dd className="num text-right">{stockText(q.minOut)} {ticker}</dd>
      <dt className="text-ink-3">Price impact</dt><dd className="num text-right">{bpsPercent(q.impactBps)}</dd>
      <dt className="text-ink-3">Route</dt><dd className="text-right">{q.route.label}</dd>
    </dl> : null}
    {q?.refused ? <Notice tone="danger" role="status" className="mt-3" title="Price impact too high">{q.refused}</Notice> : null}

    <Button size="sm" className="mt-3 w-full" disabled={!canConfirm} onClick={() => void buy()}>
      {busy ? "Buying…" : `Buy ${ticker}`}
    </Button>
  </Panel>;
}
