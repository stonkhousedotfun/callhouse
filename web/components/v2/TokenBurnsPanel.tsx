"use client";

import { formatUnits } from "viem";

import { PageHead, Panel } from "@/components/ui";
import type { FlywheelAsset, FlywheelResponse } from "@/lib/v2/api-types";
import { useFlywheel } from "@/lib/v2/hooks";

function quantity(raw: string, decimals: number | null): string {
  return decimals === null ? `${raw} base units` : formatUnits(BigInt(raw), decimals);
}

function assetLabel(asset: FlywheelAsset): string {
  return asset.symbol ?? asset.asset;
}

function hasRecordedBurn(data: FlywheelResponse): boolean {
  // The frozen API exposes the canonical Burned-event aggregate, not individual event rows.
  // A positive total is therefore the API evidence that the first burn has occurred.
  return data.burnedTotal !== null && BigInt(data.burnedTotal) > 0n;
}

export function TokenBurnsPanelView({ data }: { data: FlywheelResponse }) {
  if (!data.configured || !hasRecordedBurn(data)) return null;

  return <section aria-labelledby="token-burns-title">
    <PageHead eyebrow="Trust" title={<span id="token-burns-title">Token burns</span>}
      lede="Confirmed splitter events, reported from the v8 indexer." />

    <div className="grid gap-4 sm:grid-cols-2">
      <Panel>
        <p className="text-sm text-ink-2">Burned so far</p>
        <p className="num mt-2 text-2xl font-bold">
          {data.burnedTotal === null ? "Unavailable" : quantity(data.burnedTotal, data.tokenDecimals)}
          <span className="ml-1 text-sm font-normal text-ink-2">STONKHOUSE</span>
        </p>
      </Panel>
      <Panel>
        <p className="text-sm text-ink-2">Burned in the last 7 days</p>
        <p className="num mt-2 text-2xl font-bold">
          {data.burned7d === null ? "Unavailable" : quantity(data.burned7d, data.tokenDecimals)}
          <span className="ml-1 text-sm font-normal text-ink-2">STONKHOUSE</span>
        </p>
      </Panel>
    </div>

    <Panel className="mt-4">
      <h2 className="font-display text-lg font-bold">How fees move</h2>
      <p className="mt-2 text-sm text-ink-2">
        Only STONKHOUSE is burned. Stock Token fees are sold for USDG first. The split is set on
        chain by the fee manager, and a change waits 48 hours. Asset figures below report what the
        splitter received before that sale.
      </p>
      {data.revenue7d.length === 0 ? null : <>
        <h3 className="mt-5 font-semibold">Fees received in the last 7 days</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {data.revenue7d.map((asset) => <li key={asset.asset}>
            <span className="num font-semibold">{quantity(asset.amountRaw, asset.decimals)}</span>{" "}
            {assetLabel(asset)}
          </li>)}
        </ul>
      </>}
      {data.held.length === 0 ? null : <>
        <h3 className="mt-5 font-semibold">Awaiting sale</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {data.held.map((asset) => <li key={asset.asset}>
            <span className="num font-semibold">{quantity(asset.amountRaw, asset.decimals)}</span>{" "}
            {assetLabel(asset)}
          </li>)}
        </ul>
      </>}
    </Panel>
  </section>;
}

export function TokenBurnsPanel() {
  const flywheel = useFlywheel();
  return flywheel.data ? <TokenBurnsPanelView data={flywheel.data} /> : null;
}
