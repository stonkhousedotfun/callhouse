"use client";

import Link from "next/link";

import { buttonClasses, InfoTip, PageHead, Panel, Row, Rows, Stat } from "@/components/ui";
import { displayQuantity } from "@/lib/numberFormat";
import { adminSafeHolderDelay, formatDelay, ROLE_ID } from "@/lib/v2/adminDelays";
import type { FlywheelAsset, FlywheelResponse } from "@/lib/v2/api-types";
import { useConfig, useFlywheel } from "@/lib/v2/hooks";

function quantity(raw: string, decimals: number | null): string {
  return decimals === null ? `${raw} base units` : displayQuantity(BigInt(raw), decimals);
}

function assetLabel(asset: FlywheelAsset): string {
  return asset.symbol ?? asset.asset;
}

function hasRecordedBurn(data: FlywheelResponse): boolean {
  // The frozen API exposes the canonical Burned-event aggregate, not individual event rows.
  // A positive total is therefore the API evidence that the first burn has occurred.
  return data.burnedTotal !== null && BigInt(data.burnedTotal) > 0n;
}

/**
 * Who sets the split and how long a change waits. FeeSplitter.setBurnBps has no wait of its own; the only
 * wait is the Admin Safe's FEE_MANAGER lane delay, which is 0 at the zero-delay launch and raised by the admin's lock
 * transaction. So the sentence states the delay the chain has now (`delayS`, the Safe's indexed holder delay), and no
 * number at all when that cannot be read.
 */
export function splitChangeSentence(delayS: number | null): string {
  const who = "The split is set on chain by the fee manager";
  if (delayS === null) return `${who}.`;
  return delayS === 0 ? `${who}, and a change takes effect immediately.` : `${who}, and a change waits ${formatDelay(delayS).toLowerCase()}.`;
}

/**
 * `feeManagerDelayS` is the Admin Safe's FEE_MANAGER holder delay from /v2/config (adminDelays.adminSafeHolderDelay),
 * passed in so this view stays pure; null (the default) is unread.
 */
export function TokenBurnsPanelView({ data, feeManagerDelayS = null }: { data: FlywheelResponse; feeManagerDelayS?: number | null }) {
  if (!data.configured || !hasRecordedBurn(data)) return null;

  const cell = "min-w-0 px-4 py-4 sm:px-6 sm:py-5";
  return <section aria-labelledby="token-burns-title" className="pb-6">
    <PageHead title={<span id="token-burns-title">Token burns</span>} />

    <div className="flex flex-col gap-5">
      <Panel pad="none" className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <Stat className={cell} size="lg" label="Burned so far" unit="STONKHOUSE"
          value={data.burnedTotal === null ? "Unavailable" : quantity(data.burnedTotal, data.tokenDecimals)} />
        <Stat className={cell} size="lg" label="Burned in the last 7 days" unit="STONKHOUSE"
          value={data.burned7d === null ? "Unavailable" : quantity(data.burned7d, data.tokenDecimals)} />
      </Panel>

      <Panel as="section" aria-labelledby="fees-move-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="fees-move-title" className="flex items-center gap-1.5 text-[17px] font-bold">
            How fees move
            <InfoTip label="About fees and burns">
              Stock Token fees are sold for USDG first. {splitChangeSentence(feeManagerDelayS)} Fee amounts here are counted
              before that sale.
            </InfoTip>
          </h2>
          <p className="text-[13px] text-ink-3">Only STONKHOUSE is burned.</p>
        </div>
        {data.revenue7d.length === 0 && data.held.length === 0 ? null : <div className="grid gap-5 sm:grid-cols-2">
          {data.revenue7d.length === 0 ? null : <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-ink-3">Fees received in the last 7 days</h3>
            <Rows className="mt-1">{data.revenue7d.map((asset) => <Row key={asset.asset} k={assetLabel(asset)}
              v={quantity(asset.amountRaw, asset.decimals)} />)}</Rows>
          </div>}
          {data.held.length === 0 ? null : <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-ink-3">Awaiting sale</h3>
            <Rows className="mt-1">{data.held.map((asset) => <Row key={asset.asset} k={assetLabel(asset)}
              v={quantity(asset.amountRaw, asset.decimals)} />)}</Rows>
          </div>}
        </div>}
      </Panel>
    </div>
  </section>;
}

/**
 * /trust/burns. The PANEL above stays hidden until the first indexed Burned event -- a flywheel design
 * decision, pinned by TokenBurnsPanel.test.ts -- so on its own it
 * left the route a blank page, while the Trust page links here unconditionally. The route now always has its heading
 * and, until a burn is recorded, one plain line per state. Those lines carry no burn figures, no split, no fee-route or
 * programme copy and no promise of a future burn: before the first burn there is nothing to announce.
 */
export type TokenBurnsRouteState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unconfigured" }
  | { kind: "no-burn" }
  | { kind: "burned"; data: FlywheelResponse };

export const TOKEN_BURNS_EMPTY: Record<Exclude<TokenBurnsRouteState["kind"], "burned">, string> = {
  loading: "Loading burn records.",
  error: "Burn records could not be loaded right now.",
  unconfigured: "There are no burn records to show.",
  "no-burn": "No burn has been recorded.",
};

export function tokenBurnsRouteState(query: { data?: FlywheelResponse; isError: boolean }): TokenBurnsRouteState {
  // Data wins over a failed refetch: a burn already read stays on screen.
  if (query.data) {
    if (!query.data.configured) return { kind: "unconfigured" };
    return hasRecordedBurn(query.data) ? { kind: "burned", data: query.data } : { kind: "no-burn" };
  }
  return query.isError ? { kind: "error" } : { kind: "loading" };
}

export function TokenBurnsRouteView({ state, feeManagerDelayS = null }: { state: TokenBurnsRouteState; feeManagerDelayS?: number | null }) {
  if (state.kind === "burned") return <TokenBurnsPanelView data={state.data} feeManagerDelayS={feeManagerDelayS} />;
  return <section aria-labelledby="token-burns-title" className="pb-6">
    <PageHead title={<span id="token-burns-title">Token burns</span>} />
    <Panel className="flex flex-col items-center gap-4 py-12 text-center sm:py-14">
      <p role="status" className="text-[15px] font-semibold text-ink-2">{TOKEN_BURNS_EMPTY[state.kind]}</p>
      <Link href="/trust/markets" className={buttonClasses({ variant: "secondary", size: "sm" })}>Back to market status</Link>
    </Panel>
  </section>;
}

export function TokenBurnsRoute() {
  const config = useConfig();
  return <TokenBurnsRouteView state={tokenBurnsRouteState(useFlywheel())}
    feeManagerDelayS={adminSafeHolderDelay(config.data, ROLE_ID.FEE_MANAGER)} />;
}
