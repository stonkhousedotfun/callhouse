"use client";

import { CyclePricing, useKeeperOrderBook, type CyclePricingFeed } from "@/components/CyclePricing";
import { CycleTape } from "@/components/CycleTape";
import { ExercisePanel } from "@/components/ExercisePanel";
import { OrderPayload } from "@/components/OrderPayload";
import { GuardBadges, VaultPhaseBadge } from "@/components/PhaseBadge";
import { StrandedBanner } from "@/components/StrandedBanner";
import { Card, CardHead, CardMeta, CardTitle, ExternalLink, Notice as NoticeBox, PageHead, Row, Rows, Table, Unit } from "@/components/ui";
import { cn } from "@/lib/cn";
import { addressUrl } from "@/lib/chain";
import { CLEARINGHOUSE, MARKET, MAX_LISTINGS_PER_CYCLE, SEAPORT, VAULT } from "@/lib/contracts";
import {
  feedNotice,
  listingNotice,
  orderFinished,
  shouldAskFeed,
  windowClosed,
  type CycleListingState,
  type Notice,
} from "@/lib/cycleNotices";
import { CYCLE_TERMS_LABELS, cycleTerms } from "@/lib/cycleTerms";
import { fmtEastern, fmtUsdg, fmtUtc, maxContracts, shortHash, unitPriceUsdg } from "@/lib/format";
import { fillableForTerms } from "@/lib/orderFillable";
import { useCycleOption, useNow, useOrderStatus, useVaultSnapshot } from "@/lib/hooks";

/**
 * Ledger rows whose value cannot sit beside its label in a narrow card put the value under the
 * label, left-aligned, instead of the Row default (a right-aligned value that breaks mid-run). The
 * width is the card's own (the cards below are `@container`), so it tracks the two-column layout.
 */
const STACK_540 =
  "@max-[540px]:flex-col @max-[540px]:items-start! @max-[540px]:gap-y-1 @max-[540px]:[&>dd]:ml-0 @max-[540px]:[&>dd]:text-left";
const STACK_420 =
  "@max-[420px]:flex-col @max-[420px]:items-start! @max-[420px]:gap-y-1 @max-[420px]:[&>dd]:ml-0 @max-[420px]:[&>dd]:text-left";
/** Always under its label: the full order hash, balanced over its lines. */
const STACK_HASH =
  "flex-col items-start! gap-y-1 [&>dd]:ml-0 [&>dd]:text-left [&>dd]:break-all [&>dd]:text-balance [&>dd]:text-[12.5px] [&>dd]:leading-snug [&>dd]:text-ink-2";

/** A cycle notice from lib/cycleNotices, in the Daylight notice box. Only integrity is red. */
function NoticeBlock({ notice }: { notice: Notice }) {
  return (
    <NoticeBox tone={notice.tone === "bad" ? "danger" : notice.tone} title={notice.heading}>
      {notice.body}
      {notice.items !== undefined ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5">
          {notice.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : null}
    </NoticeBox>
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
  const feed = useKeeperOrderBook(v.listingHash, askFeed);
  const feedBook = askFeed ? feed.data : undefined;
  const feedListing = feedBook?.listings.find((l) => l.orderHash.toLowerCase() === v.listingHash?.toLowerCase());
  const chainNotice = listingNotice(listingState);
  const orderFeedNotice = feedNotice(listingState, askFeed && feed.isLoading ? "loading" : feedBook, feedListing !== undefined);

  const unitPrice = unitPriceUsdg(v.listingGrossUsdg, v.listingAmount);

  // THE ORDER'S FIGURES (lib/cycleTerms.ts). Contracts left to buy is Seaport's count for the
  // vault's listingHash as this page reads it, else the checked feed row's (the route's own
  // Seaport read), else 0 when the route reports the hash sold out, cancelled or expired. With
  // none of those (Seaport's read has not answered or failed, and the feed has no row), or outside
  // Listed, or once the sale window has closed, lib/orderFillable.ts gives no count and the rows
  // show "—", never the whole listing. cycleTerms caps the count at the vault's capacity. The
  // totals are that count times the listed unit price, and the fee on it floored as
  // Policy.splitHarvest floors it.
  const fillable = fillableForTerms({
    phase: v.phase,
    listingHash: v.listingHash,
    listingAmount: v.listingAmount,
    windowClosed: windowClosed(listingState),
    seaportStatus,
    rows: feedListing === undefined ? undefined : [feedListing],
    closed: feedBook?.closed,
  });
  // What the pricing card says when the feed has no row for the hash: why it has none.
  const pricingFeed: CyclePricingFeed = orderFinished(listingState)
    ? "order-finished"
    : !askFeed || feed.isLoading
      ? "loading"
      : feedBook === undefined || !feedBook.configured || feedBook.error !== undefined
        ? "unread"
        : "not-served";
  const terms = cycleTerms(v, { fillableContracts: fillable?.contracts });
  const cap = maxContracts(v.totalAssets, v.policy);
  const tupleMismatch = option?.agreesWithVault === false;
  // The clearinghouse is a deploy-time choice recorded in the vault. The checks and the tuple read
  // follow the vault's answer; a build whose compiled constant disagrees is a configuration fault
  // worth saying out loud, because the docs page and the explorer links print the constant.
  const clearinghouse = v.clear ?? CLEARINGHOUSE;
  const clearMismatch = v.clear !== undefined && v.clear.toLowerCase() !== CLEARINGHOUSE.toLowerCase();

  return (
    <>
      <PageHead
        eyebrow={<>Cycle · {MARKET}</>}
        title={<>This week&apos;s call, and where to buy it</>}
        lede={
          <p>
            Each week the keeper creates one out-of-the-money option type on the clearinghouse and the vault arms it after
            checking the strike, the lot and the window itself. The vault then authorises one Seaport order for it; this
            page is where that order is filled. Nothing is written until you buy: the fill itself writes exactly the
            contracts you take, so the vault never holds an unsold call. Everything below is read from the chain, except
            the order&apos;s parameters from the vault&apos;s keeper, checked against the chain first, and the keeper&apos;s
            own report of how it priced the order, which the chain cannot check and which is labelled as such.
          </p>
        }
      />

      <div className="grid min-w-0 gap-4 sm:gap-5">
        {/* An RPC failure must never read as "the vault is empty". Every figure below comes from
            one multicall batch; if that batch failed, say so instead of printing em dashes that
            look like facts. */}
        {chainReadFailed ? (
          <NoticeBox tone="warn" title={<>Chain reads are failing right now.</>}>
            The vault could not be read from the RPC, so the figures below are missing rather than zero. They fill in by
            themselves when the node answers again.
          </NoticeBox>
        ) : null}

        {clearMismatch ? (
          <NoticeBox tone="danger" title={<>This build names a different clearinghouse from the vault.</>}>
            The vault was constructed with {v.clear}; NEXT_PUBLIC_CLEARINGHOUSE is {CLEARINGHOUSE}. Every check on this
            page follows the vault&apos;s, so the order below is still checked correctly, but the build should be fixed
            before anything else is read from it.
          </NoticeBox>
        ) : null}

        <StrandedBanner snapshot={v} compact />

        <div className="min-w-0">
          <CycleTape snapshot={v} />
        </div>

        {/* Two columns from 960px: the week and its on-chain order on the left, the buy side (the
            chain and feed notices, then the fill card) on the right. The DOM order is the reading
            order, so below 960px it is one column in the same sequence. When the buy side renders
            nothing, the left column takes the full width. */}
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,410px)] xl:grid-cols-[minmax(0,1fr)_minmax(0,450px)] lg:has-[>div:last-child:empty]:grid-cols-1">
          <div className="grid min-w-0 gap-4 sm:gap-5">
            <Card className="@container">
              <CardHead>
                <CardTitle>This week&apos;s option · vault cycle #{v.cycleNumber ?? "—"}</CardTitle>
                <VaultPhaseBadge snapshot={v} nowSeconds={nowSeconds} />
              </CardHead>

              {v.phase === 0 || v.optionId === undefined || v.optionId === 0n ? (
                <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
                  {!v.ready
                    ? "Reading the vault…"
                    : "Nothing is armed right now. The keeper arms the week's option type with rollOpen; the strike, exercise time and expiry appear here when it does."}
                </p>
              ) : (
                <>
                  <Rows>
                    <Row
                      k="Strike, per contract"
                      className={STACK_420}
                      v={
                        <>
                          {terms?.strikeFmt ?? fmtUsdg(v.cycleStrikeUsdg)} <Unit>USDG</Unit>
                        </>
                      }
                    />
                    {terms?.strikeAboveSpotUsdg !== undefined ? (
                      <Row
                        title="The vault's strike less the spot its own price gate reads now, in USDG. It moves with spot; negative once spot is above the strike."
                        k={CYCLE_TERMS_LABELS.strikeAboveSpot}
                        className={STACK_420}
                        v={
                          <>
                            {terms.strikeAboveSpotFmt} <Unit>USDG</Unit>
                          </>
                        }
                      />
                    ) : null}
                    <Row
                      title="The band the vault applies at today's spot. Both bounds are checked when a cycle is armed; the floor is re-checked at every fill, so a rally can make the vault refuse a sale until the keeper reprices."
                      k={<>Band at today&apos;s spot</>}
                      className={STACK_420}
                      v={
                        v.band ? (
                          <>
                            {fmtUsdg(v.band.min)} – {fmtUsdg(v.band.max)} <Unit>USDG</Unit>
                            {v.cycleStrikeUsdg !== undefined && v.cycleStrikeUsdg < v.band.min ? (
                              <span className="font-body">{" · strike now below the floor"}</span>
                            ) : (
                              ""
                            )}
                          </>
                        ) : v.spotStale ? (
                          <span className="font-body">spot stale — the vault will not sell</span>
                        ) : (
                          "—"
                        )
                      }
                    />
                    <Row
                      title="The option type's exercise and expiry timestamps, snapshotted by the vault at rollOpen. The keeper targets the NYSE close, 16:00 Eastern, and 24 hours later; the figures are the chain's."
                      k="Sale window closes"
                      className={STACK_540}
                      v={
                        <>
                          <span className="whitespace-nowrap">{fmtUtc(v.cycleExerciseTs)}</span> ·{" "}
                          <span className="whitespace-nowrap">{fmtEastern(v.cycleExerciseTs)}</span>
                        </>
                      }
                    />
                    <Row
                      k="Expiry"
                      className={STACK_540}
                      v={
                        <>
                          <span className="whitespace-nowrap">{fmtUtc(v.cycleExpiryTs)}</span> ·{" "}
                          <span className="whitespace-nowrap">{fmtEastern(v.cycleExpiryTs)}</span>
                        </>
                      }
                    />
                    <Row
                      k="Lot"
                      v={
                        option?.underlyingAmount === undefined
                          ? optionLoading
                            ? "reading the clearinghouse…"
                            : "—"
                          : (
                            <>
                              {option.underlyingAmount === 10n ** 18n ? "1.0000" : option.underlyingAmount.toString()}{" "}
                              <Unit>{MARKET} per contract</Unit>
                            </>
                          )
                      }
                    />
                    <Row
                      title="contractsWritten(): every contract was written inside the fill that sold it, so this is also the number sold."
                      k="Calls sold this week"
                      v={
                        <>
                          {v.contractsWritten === undefined ? "—" : v.contractsWritten.toString()}
                          {cap !== undefined ? (
                            <>
                              {" "}
                              <Unit>of at most</Unit> {cap.toString()}
                            </>
                          ) : (
                            ""
                          )}
                        </>
                      }
                    />
                    <Row
                      title="Policy.maxContracts(totalAssets) − contractsWritten. The hook re-sizes every fill against NAV, so a listing approved at capacity can still be refused at the margin if NAV fell."
                      k="Capacity remaining"
                      v={
                        v.capacity === undefined ? (
                          "—"
                        ) : (
                          <>
                            {v.capacity.toString()} <Unit>contracts</Unit>
                          </>
                        )
                      }
                    />
                    <Row
                      k="Feed spot, one lot"
                      v={
                        v.spotStale ? (
                          <span className="font-body">stale — the vault will not sell</span>
                        ) : (
                          <>
                            {fmtUsdg(v.spotUsdg)} <Unit>USDG</Unit>
                          </>
                        )
                      }
                    />
                    <Row
                      k="Option id"
                      v={
                        <span title={v.optionId.toString()}>
                          {shortHash(`0x${v.optionId.toString(16).padStart(64, "0")}`)}
                        </span>
                      }
                    />
                  </Rows>

                  {tupleMismatch ? (
                    <NoticeBox
                      tone="danger"
                      className="mt-4"
                      title={<>The clearinghouse&apos;s tuple for this option id does not match the vault&apos;s snapshot.</>}
                    >
                      Strike, exercise or expiry differ between clearinghouse.option() and the vault&apos;s cycle. That
                      should be impossible (the tuple is immutable and the vault read it at rollOpen); do not buy until it
                      is understood.
                    </NoticeBox>
                  ) : null}

                  <p className="mt-4 border-t border-line pt-4 text-[12.5px] leading-[1.55] text-ink-3">
                    The strike, window and lot are read back from the clearinghouse&apos;s own tuple for this id and
                    cross-checked against the vault&apos;s snapshot. There is no registry: the vault validates the type
                    itself at rollOpen. Settlement never reads a price feed — the spot above is a gate and a display
                    number only.
                  </p>
                </>
              )}
            </Card>

            <Card className="@container">
              <CardHead>
                <CardTitle>The vault&apos;s order, on chain</CardTitle>
                <GuardBadges snapshot={v} />
              </CardHead>

              {hasOnChainListing ? (
                <Rows>
                  <Row
                    k="Seaport order hash"
                    v={v.listingHash}
                    className={STACK_HASH}
                  />
                  <Row
                    title="listingAmount(): the whole offer. At approval it was at most the vault's capacity."
                    k="Contracts offered"
                    v={(v.listingAmount ?? 0n).toString()}
                  />
                  <Row
                    k="Gross premium asked"
                    mono={false}
                    className={cn(STACK_420, "[&>dd]:text-ink-2")}
                    v={
                      <>
                        <span className="num text-ink">{fmtUsdg(v.listingGrossUsdg)}</span> USDG · one leg, to the vault
                      </>
                    }
                  />
                  <Row
                    k={CYCLE_TERMS_LABELS.unitPrice}
                    v={
                      terms?.unitPrice6 !== undefined ? (
                        <>
                          {terms.unitPriceFmt} <Unit>USDG</Unit>
                        </>
                      ) : unitPrice === undefined ? (
                        "—"
                      ) : (
                        <>
                          {fmtUsdg(unitPrice, 6)} <Unit>USDG</Unit>
                        </>
                      )
                    }
                  />
                  {v.phase === 1 ? (
                    <>
                      <Row
                        title="Contracts in this order a buyer can still take: Seaport's filled fraction for the vault's order hash as this page reads it, or as the order feed route read it, capped at the vault's capacity. Not shown while neither has answered, or once the sale window has closed."
                        k={CYCLE_TERMS_LABELS.fillableContracts}
                        v={terms?.fillableContractsFmt ?? "—"}
                      />
                      <Row
                        title="Price per contract times contracts left to buy: the arithmetic of the order as it stands. If nobody buys, the vault receives nothing."
                        k={CYCLE_TERMS_LABELS.orderGrossIfAllFill}
                        className={STACK_420}
                        v={
                          terms?.orderGrossIfAllFill6 === undefined ? (
                            "—"
                          ) : (
                            <>
                              {terms.orderGrossIfAllFillFmt} <Unit>USDG</Unit>
                            </>
                          )
                        }
                      />
                      <Row
                        title="policy().protocolFeeBps of that total, rounded down as the vault rounds it. The vault charges the fee once, at harvest, on the week's whole premium."
                        k={CYCLE_TERMS_LABELS.orderFeeIfAllFill}
                        className={STACK_420}
                        v={
                          terms?.orderFeeIfAllFill6 === undefined ? (
                            "—"
                          ) : (
                            <>
                              {terms.orderFeeIfAllFillFmt} <Unit>USDG</Unit>
                            </>
                          )
                        }
                      />
                    </>
                  ) : null}
                  <Row
                    k="Seaport validated"
                    mono={false}
                    className={STACK_420}
                    v={
                      orderStatus === undefined
                        ? "—"
                        : orderStatus.isCancelled
                          ? "cancelled"
                          : orderStatus.isValidated
                            ? "validated (empty signature fills)"
                            : "not validated"
                    }
                  />
                  <Row
                    k="Filled fraction, per Seaport"
                    v={
                      orderStatus?.totalSize !== undefined && orderStatus.totalSize > 0n
                        ? `${orderStatus.totalFilled?.toString()} / ${orderStatus.totalSize.toString()}`
                        : "0 / 0"
                    }
                  />
                  <Row
                    title="approveListing calls this cycle, cancelled or not. A relist is a reprice."
                    k="Listings authorised this cycle"
                    v={
                      <>
                        {v.listingsThisCycle ?? 0} / {MAX_LISTINGS_PER_CYCLE}
                      </>
                    }
                  />
                </Rows>
              ) : (
                <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
                  {/* `undefined` is "we have not read the vault", `0x00…00` is "the vault has no live
                      listing". They are different claims and only the second one is ours to make. */}
                  {v.listingHash === undefined
                    ? "The vault's listing slot has not been read yet."
                    : "No listing is authorised on chain right now. The vault authorises an order by hash with approveListing() after arming a cycle, so an empty hash here means nothing has been listed yet."}
                </p>
              )}

              {/* Each label travels with its address, so a line never ends on a label or a separator. */}
              <p className="mt-4 flex flex-wrap gap-x-[0.4em] gap-y-1 border-t border-line pt-4 text-[12.5px] leading-[1.55] text-ink-3 [overflow-wrap:anywhere]">
                <span className="min-w-0">
                  Clearinghouse (the vault&apos;s <code>clear()</code>){" "}
                  <ExternalLink href={addressUrl(clearinghouse)} className="link num">
                    {clearinghouse}
                  </ExternalLink>
                </span>{" "}
                <span className="min-w-0">
                  · Seaport{" "}
                  <ExternalLink href={addressUrl(SEAPORT)} className="link num">
                    {SEAPORT}
                  </ExternalLink>
                </span>
                {VAULT ? (
                  <>
                    {" "}
                    <span className="min-w-0">
                      · zone = the vault{" "}
                      <ExternalLink href={addressUrl(VAULT)} className="link num">
                        {shortHash(VAULT)}
                      </ExternalLink>
                    </span>
                  </>
                ) : null}
              </p>
            </Card>

            {hasOnChainListing ? (
              <CyclePricing
                listing={feedListing}
                feed={pricingFeed}
                vaultStrike6={v.cycleStrikeUsdg}
                vaultUnitPrice6={unitPrice}
              />
            ) : null}
          </div>

          <div className="grid min-w-0 gap-4 empty:hidden sm:gap-5">
            {chainNotice !== null ? <NoticeBlock notice={chainNotice} /> : null}

            {orderFeedNotice === "loading" ? (
              <Card pad="sm">
                <span className="text-sm text-ink-2">Reading the order from the keeper…</span>
              </Card>
            ) : orderFeedNotice !== null ? (
              <NoticeBlock notice={orderFeedNotice} />
            ) : null}

            {/* The vault's order, through the one fill path. It is only ever a row whose hash is the
                vault's listingHash, and OrderPayload refuses to render a fill button until the row
                matches every value in the vault's own slot and a simulated fill passes. */}
            {feedListing !== undefined ? (
              <div key={`order-${feedListing.orderHash}`} className="min-w-0">
                <OrderPayload listing={feedListing} snapshot={v} seaportStatus={seaportStatus} />
              </div>
            ) : null}

            {/* Exercise, for a connected wallet that holds this week's option. It renders nothing
                for anyone else (no wrapper element here), so this column stays :empty for them.
                The window, strike and lot are the clearinghouse's own tuple and the clock is the
                chain's latest block (components/ExercisePanel.tsx). */}
            <ExercisePanel snapshot={v} />
          </div>
        </div>

        {feedBook !== undefined && feedBook.closed.some((c) => c.state === "notCurrent") ? (
          <Card>
            <CardHead>
              <CardTitle>Earlier orders the keeper still serves</CardTitle>
              <CardMeta>{feedBook.closed.filter((c) => c.state === "notCurrent").length}</CardMeta>
            </CardHead>
            <Table label="Earlier orders the keeper still serves" bleed minWidth={300}>
              <thead>
                <tr>
                  <th className="w-px pr-8!">Order hash</th>
                  <th className="text-left!">State</th>
                </tr>
              </thead>
              <tbody>
                {feedBook.closed
                  .filter((c) => c.state === "notCurrent")
                  .map((c, i) => (
                    <tr key={c.orderHash ?? i}>
                      <td title={c.orderHash ?? undefined} className="pr-8!">
                        {shortHash(c.orderHash)}
                      </td>
                      <td className="font-body! text-left! whitespace-normal! text-ink-2!">
                        superseded: not the order the vault authorises now
                      </td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </Card>
        ) : null}

        <Card>
          <CardHead>
            <CardTitle>How a fill works here</CardTitle>
          </CardHead>
          <p className="max-w-[78ch] text-[15px] leading-[1.7] text-ink-2">
            The order is a PARTIAL_RESTRICTED Seaport 1.6 order whose offerer and zone are both the vault, with one
            payment leg (USDG, to the vault) and an empty signature. When you fill k of N, Seaport calls the vault
            before moving anything; the vault re-checks its gate at today&apos;s spot (the strike is still above its
            floor, the premium clears its floor, the size fits its capacity, the window is open, the oracle is live,
            writes are not halted) and writes exactly k contracts into Valorem inside your transaction. Seaport then
            moves them to you and pulls k × the unit price in USDG to the vault, and the vault confirms nothing stayed
            behind. So a fill can be refused after a rally, and this page simulates yours before the button is live.
            The order is validated on chain, so the signature is empty; any Seaport 1.6 client can fill it from the
            raw JSON on the card with fulfillAdvancedOrder(numerator k, denominator N) after approving k × the unit
            price of USDG to Seaport.
          </p>
        </Card>
      </div>
    </>
  );
}
