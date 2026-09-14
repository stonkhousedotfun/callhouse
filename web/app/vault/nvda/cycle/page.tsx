"use client";

import { useQuery } from "@tanstack/react-query";

import { CycleTape } from "@/components/CycleTape";
import { OrderPayload } from "@/components/OrderPayload";
import { GuardBadges, PhaseBadge } from "@/components/PhaseBadge";
import { StrandedBanner } from "@/components/StrandedBanner";
import { fetchKeeperOrderBook } from "@/lib/api";
import { addressUrl } from "@/lib/chain";
import { CLEARINGHOUSE, MARKET, MAX_LISTINGS_PER_CYCLE, SEAPORT, VAULT } from "@/lib/contracts";
import { feedNotice, listingNotice, shouldAskFeed, type CycleListingState, type Notice } from "@/lib/cycleNotices";
import { fmtUsdg, fmtUtc, maxContracts, shortHash, unitPriceUsdg } from "@/lib/format";
import { useCycleOption, useNow, useOrderStatus, useVaultSnapshot } from "@/lib/hooks";

function NoticeBlock({ notice }: { notice: Notice }) {
  return (
    <div className="notice" data-tone={notice.tone}>
      <strong>{notice.heading}</strong>
      {notice.body}
      {notice.items !== undefined ? (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {notice.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The fill page: this week's option type, the vault's authorised order, and the one place the
 * calls are sold.
 *
 * THE VENUE. Under write on fill the vault lists a PARTIAL_RESTRICTED Seaport order whose zone is
 * the vault itself. Seaport calls the vault's `authorizeOrder` before it moves anything; that
 * hook writes exactly the contracts being bought into Valorem, so nothing exists before a fill and
 * nothing unsold ever sits in the vault. The order's parameters live with the keeper that built
 * it, served at its GET /orders and checked against the chain by app/api/keeper/orders before
 * they reach this page (lib/keeperOrders.ts); the card checks them again and simulates the fill.
 *
 * SEAPORT FIRST. The vault's `listingHash()` is the one authoritative statement of which order is
 * ours, and Seaport's `getOrderStatus` for it says what is left. A sold-out or cancelled order is
 * a neutral notice and the feed is not asked (lib/cycleNotices.ts).
 */
export default function CyclePage() {
  const { data: v, isError: chainReadFailed } = useVaultSnapshot();
  const { data: option, isLoading: optionLoading } = useCycleOption(v);
  const { data: orderStatus } = useOrderStatus(v.listingHash);
  const nowSeconds = useNow();

  const hasOnChainListing = v.listingHash !== undefined && !/^0x0+$/.test(v.listingHash);

  // Seaport's status, in the shape the pure checks take. useOrderStatus fills every field or none.
  const seaportStatus =
    orderStatus?.isCancelled !== undefined && orderStatus.totalFilled !== undefined && orderStatus.totalSize !== undefined
      ? { isCancelled: orderStatus.isCancelled, totalFilled: orderStatus.totalFilled, totalSize: orderStatus.totalSize }
      : undefined;

  const listingState: CycleListingState = {
    vaultConfigured: VAULT !== undefined,
    phase: v.phase,
    listingHash: v.listingHash,
    listingAmount: v.listingAmount,
    seaportStatus,
    cycleExerciseTs: v.cycleExerciseTs,
    nowSeconds,
  };

  // THE ORDER FEED. Read only when the vault has a live hash and Seaport has contracts left. The
  // route rebuilds and checks every order against the chain and returns only the vault's
  // authorised listing; OrderPayload checks it again. When the deployment has no
  // KEEPER_ORDERS_URL the route says so and the page says the feed is not wired.
  const askFeed = shouldAskFeed(listingState);
  const feed = useQuery({
    queryKey: ["keeper-orders", VAULT ?? "none", v.listingHash ?? "none"],
    enabled: askFeed,
    refetchInterval: 30_000,
    queryFn: fetchKeeperOrderBook,
  });
  const feedBook = askFeed ? feed.data : undefined;
  const feedListing = feedBook?.listings.find((l) => l.orderHash.toLowerCase() === v.listingHash?.toLowerCase());
  const chainNotice = listingNotice(listingState);
  const orderFeedNotice = feedNotice(listingState, askFeed && feed.isLoading ? "loading" : feedBook, feedListing !== undefined);

  const unitPrice = unitPriceUsdg(v.listingGrossUsdg, v.listingAmount);
  const cap = maxContracts(v.totalAssets, v.policy);
  const tupleMismatch = option?.agreesWithVault === false;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Cycle · {MARKET}</div>
        <h1>This week&apos;s call, and where to buy it</h1>
        <p className="lede">
          Each week the keeper creates one out-of-the-money option type on the clearinghouse and the vault arms it after
          checking the strike, the lot and the window itself. The vault then authorises one Seaport order for it; this
          page is where that order is filled. Nothing is written until you buy: the fill itself writes exactly the
          contracts you take, so the vault never holds an unsold call. Everything below is read from the chain, and
          the order&apos;s parameters from the vault&apos;s keeper, checked against the chain first.
        </p>
      </div>

      {/* An RPC failure must never read as "the vault is empty". Every figure below comes from
          one multicall batch; if that batch failed, say so instead of printing em dashes that
          look like facts. */}
      {chainReadFailed ? (
        <div className="notice" data-tone="warn">
          <strong>Chain reads are failing right now.</strong>
          The vault could not be read from the RPC, so the figures below are missing rather than zero. They fill in by
          themselves when the node answers again.
        </div>
      ) : null}

      <StrandedBanner snapshot={v} compact />

      <div style={{ marginTop: v.isStranded ? 16 : 0 }}>
        <CycleTape snapshot={v} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">This week&apos;s option · vault cycle #{v.cycleNumber ?? "—"}</span>
          <PhaseBadge phase={v.phase} fillState={v.fillState} sold={v.contractsWritten} />
        </div>

        {v.phase === 0 || v.optionId === undefined || v.optionId === 0n ? (
          <p className="small muted" style={{ marginBottom: 0 }}>
            {!v.ready
              ? "Reading the vault…"
              : "Nothing is armed right now. The keeper arms the week's option type with rollOpen; the strike, exercise time and expiry appear here when it does."}
          </p>
        ) : (
          <>
            <div className="rows">
              <div className="row">
                <span className="k">Strike, per contract</span>
                <span className="v">
                  {fmtUsdg(v.cycleStrikeUsdg)} USDG
                  {option?.otmBps !== undefined
                    ? ` · ${option.otmBps >= 0 ? "+" : ""}${(option.otmBps / 100).toFixed(2)}% vs spot`
                    : ""}
                </span>
              </div>
              <div className="row" title="The band the vault applies at today's spot. Both bounds are checked when a cycle is armed; the floor is re-checked at every fill, so a rally can make the vault refuse a sale until the keeper reprices.">
                <span className="k">Band at today&apos;s spot</span>
                <span className="v">
                  {v.band
                    ? `${fmtUsdg(v.band.min)} – ${fmtUsdg(v.band.max)} USDG${
                        v.cycleStrikeUsdg !== undefined && v.cycleStrikeUsdg < v.band.min ? " · strike now below the floor" : ""
                      }`
                    : v.spotStale
                      ? "spot stale — the vault will not sell"
                      : "—"}
                </span>
              </div>
              <div className="row">
                <span className="k">Sale window closes · expiry</span>
                <span className="v">
                  {fmtUtc(v.cycleExerciseTs)} · {fmtUtc(v.cycleExpiryTs)}
                </span>
              </div>
              <div className="row">
                <span className="k">Lot</span>
                <span className="v">
                  {option?.underlyingAmount === undefined
                    ? optionLoading
                      ? "reading the clearinghouse…"
                      : "—"
                    : `${option.underlyingAmount === 10n ** 18n ? "1.0000" : option.underlyingAmount.toString()} ${MARKET} per contract`}
                </span>
              </div>
              <div className="row" title="contractsWritten(): every contract was written inside the fill that sold it, so this is also the number sold.">
                <span className="k">Calls sold this week</span>
                <span className="v">
                  {v.contractsWritten === undefined ? "—" : v.contractsWritten.toString()}
                  {cap !== undefined ? ` of at most ${cap.toString()}` : ""}
                </span>
              </div>
              <div className="row" title="Policy.maxContracts(totalAssets) − contractsWritten. The hook re-sizes every fill against NAV, so a listing approved at capacity can still be refused at the margin if NAV fell.">
                <span className="k">Capacity remaining</span>
                <span className="v">{v.capacity === undefined ? "—" : `${v.capacity.toString()} contracts`}</span>
              </div>
              <div className="row">
                <span className="k">Feed spot, one lot</span>
                <span className="v">{v.spotStale ? "stale — the vault will not sell" : `${fmtUsdg(v.spotUsdg)} USDG`}</span>
              </div>
              <div className="row">
                <span className="k">Option id</span>
                <span className="v mono" title={v.optionId.toString()}>
                  {shortHash(`0x${v.optionId.toString(16).padStart(64, "0")}`)}
                </span>
              </div>
            </div>

            {tupleMismatch ? (
              <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
                <strong>The clearinghouse&apos;s tuple for this option id does not match the vault&apos;s snapshot.</strong>
                Strike, exercise or expiry differ between clearinghouse.option() and the vault&apos;s cycle. That
                should be impossible (the tuple is immutable and the vault read it at rollOpen); do not buy until it
                is understood.
              </div>
            ) : null}

            <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
              The strike, window and lot are read back from the clearinghouse&apos;s own tuple for this id and
              cross-checked against the vault&apos;s snapshot. There is no registry: the vault validates the type
              itself at rollOpen. Settlement never reads a price feed — the spot above is a gate and a display
              number only.
            </p>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">The vault&apos;s order, on chain</span>
          <GuardBadges writesHalted={v.writesHalted} oraclePaused={v.oraclePaused} spotStale={v.spotStale} stranded={v.isStranded} />
        </div>

        {hasOnChainListing ? (
          <div className="rows">
            <div className="row">
              <span className="k">Seaport order hash</span>
              <span className="v kv-mono">{v.listingHash}</span>
            </div>
            <div className="row" title="listingAmount(): the whole offer. At approval it was at most the vault's capacity.">
              <span className="k">Contracts offered</span>
              <span className="v">{(v.listingAmount ?? 0n).toString()}</span>
            </div>
            <div className="row">
              <span className="k">Gross premium asked</span>
              <span className="v">{fmtUsdg(v.listingGrossUsdg)} USDG · one leg, to the vault</span>
            </div>
            <div className="row">
              <span className="k">Per contract</span>
              <span className="v">{unitPrice === undefined ? "—" : `${fmtUsdg(unitPrice, 6)} USDG`}</span>
            </div>
            <div className="row">
              <span className="k">Seaport validated</span>
              <span className="v">
                {orderStatus === undefined
                  ? "—"
                  : orderStatus.isCancelled
                    ? "cancelled"
                    : orderStatus.isValidated
                      ? "validated (empty signature fills)"
                      : "not validated"}
              </span>
            </div>
            <div className="row">
              <span className="k">Filled fraction, per Seaport</span>
              <span className="v">
                {orderStatus?.totalSize !== undefined && orderStatus.totalSize > 0n
                  ? `${orderStatus.totalFilled?.toString()} / ${orderStatus.totalSize.toString()}`
                  : "0 / 0"}
              </span>
            </div>
            <div className="row" title="approveListing calls this cycle, cancelled or not. A relist is a reprice.">
              <span className="k">Listings authorised this cycle</span>
              <span className="v">
                {v.listingsThisCycle ?? 0} / {MAX_LISTINGS_PER_CYCLE}
              </span>
            </div>
          </div>
        ) : (
          <p className="small muted" style={{ marginBottom: 0 }}>
            {/* `undefined` is "we have not read the vault", `0x00…00` is "the vault has no live
                listing". They are different claims and only the second one is ours to make. */}
            {v.listingHash === undefined
              ? "The vault's listing slot has not been read yet."
              : "No listing is authorised on chain right now. The vault authorises an order by hash with approveListing() after arming a cycle, so an empty hash here means nothing has been listed yet."}
          </p>
        )}

        <p className="tiny faint" style={{ marginTop: 12, marginBottom: 0 }}>
          Clearinghouse{" "}
          <a href={addressUrl(CLEARINGHOUSE)} target="_blank" rel="noreferrer noopener">
            {CLEARINGHOUSE}
          </a>{" "}
          · Seaport{" "}
          <a href={addressUrl(SEAPORT)} target="_blank" rel="noreferrer noopener">
            {SEAPORT}
          </a>
          {VAULT ? (
            <>
              {" "}
              · zone = the vault{" "}
              <a href={addressUrl(VAULT)} target="_blank" rel="noreferrer noopener">
                {shortHash(VAULT)}
              </a>
            </>
          ) : null}
        </p>
      </div>

      {chainNotice !== null ? (
        <div style={{ marginTop: 16 }}>
          <NoticeBlock notice={chainNotice} />
        </div>
      ) : null}

      {orderFeedNotice === "loading" ? (
        <div className="card" style={{ marginTop: 16 }}>
          <span className="small muted">Reading the order from the keeper…</span>
        </div>
      ) : orderFeedNotice !== null ? (
        <div style={{ marginTop: 16 }}>
          <NoticeBlock notice={orderFeedNotice} />
        </div>
      ) : null}

      {/* The vault's order, through the one fill path. It is only ever a row whose hash is the
          vault's listingHash, and OrderPayload refuses to render a fill button until the row
          matches every value in the vault's own slot and a simulated fill passes. */}
      {feedListing !== undefined ? (
        <div key={`order-${feedListing.orderHash}`} style={{ marginTop: 16 }}>
          <OrderPayload listing={feedListing} snapshot={v} seaportStatus={seaportStatus} />
        </div>
      ) : null}

      {feedBook !== undefined && feedBook.closed.some((c) => c.state === "notCurrent") ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <span className="card-title">Earlier orders the keeper still serves</span>
            <span className="tiny faint mono">{feedBook.closed.filter((c) => c.state === "notCurrent").length}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order hash</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {feedBook.closed
                  .filter((c) => c.state === "notCurrent")
                  .map((c, i) => (
                    <tr key={c.orderHash ?? i}>
                      <td title={c.orderHash ?? undefined}>{shortHash(c.orderHash)}</td>
                      <td style={{ whiteSpace: "normal" }}>superseded: not the order the vault authorises now</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">How a fill works here</div>
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
          The order is a PARTIAL_RESTRICTED Seaport 1.6 order whose zone is the vault. When you fill k of N, Seaport
          calls the vault before moving anything; the vault re-checks its gate at today&apos;s spot (the strike is
          still above its floor, the premium clears its floor, the size fits its capacity, the window is open, the
          oracle is live, writes are not halted) and writes exactly k contracts into Valorem inside your transaction.
          Seaport then moves them to you and pulls k × the unit price in USDG to the vault, and the vault confirms
          nothing stayed behind. So a fill can be refused after a rally, and this page simulates yours before the
          button is live. The order is validated on chain, so the signature is empty; any Seaport 1.6 client can fill
          it from the raw JSON on the card.
        </p>
      </div>
    </>
  );
}
