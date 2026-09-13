"use client";

import { useQuery } from "@tanstack/react-query";

import { CycleTape } from "@/components/CycleTape";
import { OrderPayload } from "@/components/OrderPayload";
import { GuardBadges, PhaseBadge } from "@/components/PhaseBadge";
import { fetchKeeperOrderBook, fetchOvercallBook } from "@/lib/api";
import { CHAIN_ID, addressUrl } from "@/lib/chain";
import { CLEARINGHOUSE, MARKET, REGISTRY, SEAPORT, USDG, VAULT } from "@/lib/contracts";
import { fmtUsdg, fmtUtc, shortHash, splitPremium, unitPriceFromLegs } from "@/lib/format";
import { useLadder, useNow, useOrderStatus, useVaultSnapshot } from "@/lib/hooks";
import { checkListingIsOurs } from "@/lib/overcall";

export default function CyclePage() {
  const { data: v, isError: chainReadFailed } = useVaultSnapshot();
  const { rungs, isLoading: ladderLoading } = useLadder(v);
  const { data: orderStatus } = useOrderStatus(v.listingHash);
  const nowSeconds = useNow();

  // Overcall's book, through our own server-side proxy (their API sends no CORS headers).
  // `status=all` is only legal together with `offerer`, which is exactly the query we want:
  // every order this vault has ever posted, in whatever state. The proxy builds that query
  // from its own compiled-in vault address and ignores whatever the browser sends; the params
  // here state the intent and give the query its cache key, nothing more.
  const book = useQuery({
    queryKey: ["overcall-book", VAULT ?? "none"],
    enabled: VAULT !== undefined,
    refetchInterval: 30_000,
    queryFn: () => fetchOvercallBook({ offerer: VAULT!, status: "all", limit: 20 }),
  });

  const allListings = book.data?.listings ?? [];
  const isLive = (status: string) => status === "open" || status === "partial";
  const liveListings = allListings.filter((l) => isLive(l.status));
  const otherListings = allListings.filter((l) => !isLive(l.status));

  const hasOnChainListing = v.listingHash !== undefined && !/^0x0+$/.test(v.listingHash);

  // The vault's listingHash() is the one authoritative statement of which order is ours. The
  // row carrying that hash is looked for across the WHOLE book first, in whatever status: a row
  // that is on the book as `unfillable` (transient — recovers when approval or balance return),
  // `expired` or `filled` is still our row, and saying "the book has no listing matching" while
  // it sits in the table below would be false. Only when no row at all carries the hash is that
  // sentence used — it then means the keeper authorised a listing the book does not show, which
  // is an unfilled week in the making. Of the live rows, the matching one is the one a buyer may
  // fill from here; every other row is shown but cannot be filled, and OrderPayload says why.
  const ourRow = hasOnChainListing
    ? allListings.find((l) => l.orderHash.toLowerCase() === v.listingHash!.toLowerCase())
    : undefined;
  const matchingListing = ourRow !== undefined && isLive(ourRow.status) ? ourRow : undefined;
  const ourRowNotLive = ourRow !== undefined && matchingListing === undefined ? ourRow : undefined;
  const bookAnswered = book.data !== undefined && !book.data.error;
  const bookMissesOurHash = hasOnChainListing && bookAnswered && ourRow === undefined;
  const unmatchedLive = liveListings.filter((l) => l !== matchingListing);

  // THE KEEPER FALLBACK. Overcall first: the keeper's /orders is read only when Overcall's book
  // has answered (or failed to) and has no listing for the vault that passes the same chain check
  // OrderPayload runs. The book may be missing our row because Overcall's validator refused it
  // (L-04), may be down, or may carry a row that does not check out; in each case the keeper is
  // asked. The route (app/api/keeper/orders) rebuilds and checks every order against the chain
  // and returns only the vault's authorised listing; OrderPayload checks it again. When the
  // deployment has no KEEPER_ORDERS_URL the route says so and nothing below mentions the keeper.
  // Nothing is decided before the clock has started: an end time compared against 0 proves
  // nothing, and a fallback that flickers in for one frame is a false statement about the book.
  const overcallVerified =
    matchingListing !== undefined &&
    nowSeconds > 0 &&
    checkListingIsOurs(
      matchingListing,
      {
        vault: VAULT,
        usdg: USDG,
        clearinghouse: CLEARINGHOUSE,
        seaport: SEAPORT,
        listingHash: v.listingHash,
        chainId: CHAIN_ID,
        amount: v.listingAmount,
        grossUsdg: v.listingGrossUsdg,
        optionId: v.optionId,
      },
      nowSeconds,
    ).ok;
  const askKeeper =
    VAULT !== undefined && hasOnChainListing && nowSeconds > 0 && !book.isLoading && !overcallVerified;
  const keeper = useQuery({
    queryKey: ["keeper-orders", VAULT ?? "none", v.listingHash ?? "none"],
    enabled: askKeeper,
    refetchInterval: 30_000,
    queryFn: fetchKeeperOrderBook,
  });
  const keeperBook = askKeeper && keeper.data?.configured ? keeper.data : undefined;
  const keeperListing = keeperBook?.listings.find(
    (l) => l.orderHash.toLowerCase() === v.listingHash?.toLowerCase(),
  );

  const unitPrice = unitPriceFromLegs(v.listingGrossUsdg ?? 0n, 0n, v.listingAmount ?? 0n);
  const split = splitPremium(unitPrice ?? 0n, v.listingAmount ?? 0n);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Cycle · {MARKET}</div>
        <h1>This week&apos;s ladder and listing</h1>
        <p className="lede">
          Overcall publishes up to five strikes per cycle. The vault writes exactly one of them —
          the nearest rung inside its own out-of-the-money band — and lists the resulting option
          for USDG on Seaport. Everything below is read from the chain and from Overcall&apos;s own
          book, and, when that book does not show the vault&apos;s listing, from the vault&apos;s
          keeper, checked against the chain first.
        </p>
      </div>

      {/* An RPC failure must never read as "the vault is empty". Every figure below comes from
          one multicall batch; if that batch failed, say so instead of printing em dashes that
          look like facts. */}
      {chainReadFailed ? (
        <div className="notice" data-tone="warn">
          <strong>Chain reads are failing right now.</strong>
          The vault and registry could not be read from the RPC, so the figures below are missing
          rather than zero. They fill in by themselves when the node answers again.
        </div>
      ) : null}

      <CycleTape snapshot={v} />

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">Overcall ladder · registry cycle #{v.registryCycleNumber ?? "—"}</span>
          <PhaseBadge phase={v.phase} fillState={v.fillState} />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rung</th>
                <th>Strike (USDG)</th>
                <th>vs spot</th>
                <th>In band</th>
                <th>Approved</th>
                <th>Option id</th>
              </tr>
            </thead>
            <tbody>
              {rungs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted" style={{ whiteSpace: "normal" }}>
                    {/* "No live cycle" is a claim about the registry. Do not make it before the
                        registry has actually answered — an unread contract is not an empty one. */}
                    {!v.ready || ladderLoading || v.registryOptionIds === undefined
                      ? "Reading the registry…"
                      : "No live cycle on the registry right now."}
                  </td>
                </tr>
              ) : (
                rungs.map((rung, i) => (
                  <tr key={rung.optionId.toString()} data-picked={rung.picked}>
                    <td>
                      {rung.picked ? "▶ " : ""}
                      {i + 1}
                      {rung.picked ? " · written" : ""}
                    </td>
                    <td>{fmtUsdg(rung.strikeUsdg)}</td>
                    <td>
                      {rung.otmBps === undefined
                        ? "—"
                        : `${rung.otmBps >= 0 ? "+" : ""}${(rung.otmBps / 100).toFixed(2)}%`}
                    </td>
                    <td>{rung.inBand === undefined ? "—" : rung.inBand ? "yes" : "no"}</td>
                    <td>{rung.approved === undefined ? "—" : rung.approved ? "yes" : "no"}</td>
                    <td title={rung.optionId.toString()}>
                      {shortHash(`0x${rung.optionId.toString(16).padStart(64, "0")}`)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="rows" style={{ marginTop: 14 }}>
          <div className="row">
            <span className="k">Feed spot, one lot</span>
            <span className="v">
              {v.spotStale ? "stale — the vault will not write" : `${fmtUsdg(v.spotUsdg)} USDG`}
            </span>
          </div>
          <div className="row">
            <span className="k">Policy band</span>
            <span className="v">
              {v.policy
                ? `+${(v.policy.minOtmBps / 100).toFixed(2)}% to +${(v.policy.maxOtmBps / 100).toFixed(2)}%`
                : "—"}
            </span>
          </div>
          <div className="row">
            <span className="k">Registry</span>
            <span className="v">
              <a href={addressUrl(REGISTRY)} target="_blank" rel="noreferrer noopener">
                {REGISTRY}
              </a>
            </span>
          </div>
        </div>

        <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
          Strikes come from the registry&apos;s strikePerContract() and are cross-checked against
          ValoremClear.option().exerciseAmount. Settlement never reads a price feed — the spot
          above is a write gate and a display number only.
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">Our listing, on chain</span>
          <GuardBadges writesHalted={v.writesHalted} oraclePaused={v.oraclePaused} spotStale={v.spotStale} />
        </div>

        {hasOnChainListing ? (
          <div className="rows">
            <div className="row">
              <span className="k">Seaport order hash</span>
              <span className="v kv-mono">{v.listingHash}</span>
            </div>
            <div className="row">
              <span className="k">Contracts listed</span>
              <span className="v">{(v.listingAmount ?? 0n).toString()}</span>
            </div>
            <div className="row">
              <span className="k">Gross premium asked</span>
              <span className="v">{fmtUsdg(v.listingGrossUsdg)} USDG</span>
            </div>
            <div className="row">
              <span className="k">Per contract</span>
              <span className="v">
                {unitPrice === undefined ? "—" : `${fmtUsdg(unitPrice, 6)} USDG`}
              </span>
            </div>
            <div className="row">
              <span className="k">Split per contract</span>
              <span className="v">
                {fmtUsdg(split.writerPerContract6, 6)} vault + {fmtUsdg(split.feePerContract6, 6)} Overcall
              </span>
            </div>
            <div className="row">
              <span className="k">Seaport validated</span>
              <span className="v">
                {orderStatus === undefined
                  ? "—"
                  : orderStatus.isCancelled
                    ? "cancelled"
                    : orderStatus.isValidated
                      ? "validated"
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
            <div className="row">
              <span className="k">Listings signed this cycle</span>
              <span className="v">{v.listingsThisCycle ?? 0} / 3</span>
            </div>
          </div>
        ) : (
          <p className="small muted" style={{ marginBottom: 0 }}>
            {/* `undefined` is "we have not read the vault", `0x00…00` is "the vault has no live
                listing". They are different claims and only the second one is ours to make. */}
            {v.listingHash === undefined
              ? "The vault's listing slot has not been read yet."
              : "No listing is authorised on chain right now. The vault authorises an order by hash with approveListing() before the keeper posts it, so an empty hash here means nothing has been listed for this cycle yet."}
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
          {v.optionId !== undefined && v.optionId !== 0n ? (
            <>
              {" "}
              · option id <span className="mono">{v.optionId.toString()}</span>
            </>
          ) : null}
        </p>
      </div>

      <div style={{ marginTop: 16 }}>
        {book.isLoading ? (
          <div className="card">
            <span className="small muted">Reading Overcall&apos;s book…</span>
          </div>
        ) : book.data?.error ? (
          <div className="notice" data-tone="warn">
            <strong>Overcall&apos;s book did not answer.</strong>
            {book.data.error} The on-chain facts above still stand. If the listing exists but their
            front end does not show it, the signed payload below is everything a buyer needs.
          </div>
        ) : ourRowNotLive !== undefined ? (
          <div className="notice" data-tone="warn">
            <strong>
              Overcall&apos;s book lists the vault&apos;s order as {ourRowNotLive.status}.
            </strong>
            The vault has authorised {shortHash(v.listingHash)} on chain and the book carries that
            hash, but not as an open order, so the book&apos;s row cannot be filled from this page.{" "}
            {keeperListing !== undefined
              ? "The vault's keeper is serving the same order directly, and it is below, checked against the chain. "
              : ""}
            {ourRowNotLive.status === "unfillable"
              ? "Overcall marks an order unfillable while the offerer's approval or balance is short; it recovers by itself when they return."
              : ourRowNotLive.status === "filled"
                ? "Every contract has been bought."
                : ourRowNotLive.status === "expired"
                  ? "The order's end time has passed."
                  : "The row is in the table below."}
          </div>
        ) : bookMissesOurHash ? (
          <div className="notice" data-tone="warn">
            <strong>Overcall&apos;s book has no listing matching the vault&apos;s current order hash.</strong>
            The vault has authorised {shortHash(v.listingHash)} on chain, but no row under its
            address, open or otherwise, carries that hash.{" "}
            {liveListings.length > 0
              ? `The ${liveListings.length === 1 ? "order" : `${liveListings.length} orders`} open below ${liveListings.length === 1 ? "is" : "are"} shown for the record and cannot be filled from this page.`
              : keeperListing !== undefined
                ? "The vault's keeper is serving that order directly, and it is below, checked against the chain."
                : "An invisible listing is an unfilled week; this is the thing to escalate."}
          </div>
        ) : liveListings.length === 0 ? (
          <div className="notice" data-tone="info">
            <strong>Nothing open on Overcall&apos;s book for this vault.</strong>
            Either the keeper has not listed this cycle yet, the order was filled, or it was
            cancelled. An invisible listing is an unfilled week, so if the vault has authorised a
            hash above and nothing appears here, that is the thing to escalate.
          </div>
        ) : null}
      </div>

      {/* What the keeper said, when it was asked and nothing from it can be offered. A deployment
          without KEEPER_ORDERS_URL never reaches this: keeperBook is undefined there. */}
      {keeperBook !== undefined && keeperListing === undefined ? (
        keeperBook.rejected.length > 0 ? (
          <div className="notice" data-tone="bad" style={{ marginTop: 16 }}>
            <strong>
              The vault&apos;s keeper served{" "}
              {keeperBook.rejected.length === 1 ? "an order" : `${keeperBook.rejected.length} orders`} that did
              not check out against the chain, so nothing from the keeper is offered here.
            </strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {keeperBook.rejected.map((r, i) => (
                <li key={`${r.orderHash ?? "unnamed"}-${i}`}>
                  {r.orderHash ? `${shortHash(r.orderHash)}: ` : ""}
                  {r.reasons.join(" ")}
                </li>
              ))}
            </ul>
          </div>
        ) : keeperBook.error ? (
          <div className="notice" data-tone="warn" style={{ marginTop: 16 }}>
            <strong>The vault&apos;s keeper could not be read as a fallback.</strong>
            {keeperBook.error} Nothing from the keeper is offered until it answers and its order
            checks out against the chain.
          </div>
        ) : (
          <div className="notice" data-tone="info" style={{ marginTop: 16 }}>
            <strong>The vault&apos;s keeper is not serving a live order for this vault either.</strong>
            Nothing it served matches the hash the vault has authorised on chain.
          </div>
        )
      ) : null}

      {/* The four expected* props are the vault's own listing slot, read in one multicall:
          hash, contract count, gross price and option id. OrderPayload refuses to render a
          fill button until the row matches every one of them. */}
      {matchingListing !== undefined ? (
        <div key={matchingListing.orderHash} style={{ marginTop: 16 }}>
          <OrderPayload
            listing={matchingListing}
            expectedListingHash={v.listingHash}
            expectedListingAmount={v.listingAmount}
            expectedListingGrossUsdg={v.listingGrossUsdg}
            expectedOptionId={v.optionId}
          />
        </div>
      ) : null}

      {/* The keeper's copy of the same order, through the same card and the same fill. It is
          only ever a row whose hash is the vault's listingHash, and only when Overcall's book
          has no verified row for it. */}
      {keeperListing !== undefined ? (
        <div key={`keeper-${keeperListing.orderHash}`} style={{ marginTop: 16 }}>
          <OrderPayload
            source="keeper"
            listing={keeperListing}
            expectedListingHash={v.listingHash}
            expectedListingAmount={v.listingAmount}
            expectedListingGrossUsdg={v.listingGrossUsdg}
            expectedOptionId={v.optionId}
          />
        </div>
      ) : null}

      {unmatchedLive.map((listing) => (
        <div key={listing.orderHash} style={{ marginTop: 16 }}>
          <OrderPayload
            listing={listing}
            expectedListingHash={v.listingHash}
            expectedListingAmount={v.listingAmount}
            expectedListingGrossUsdg={v.listingGrossUsdg}
            expectedOptionId={v.optionId}
          />
        </div>
      ))}

      {otherListings.length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            {/* "Earlier" is only true when the current cycle's row is not among them. */}
            <span className="card-title">
              {ourRowNotLive !== undefined
                ? "Orders from this vault that are not open"
                : "Earlier orders from this vault"}
            </span>
            <span className="tiny faint mono">{otherListings.length}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order hash</th>
                  <th>Status</th>
                  <th>Qty</th>
                  <th>Unit (USDG)</th>
                  <th>Ends</th>
                </tr>
              </thead>
              <tbody>
                {otherListings.map((l) => (
                  <tr key={l.orderHash} data-picked={l === ourRowNotLive}>
                    <td title={l.orderHash}>
                      {shortHash(l.orderHash)}
                      {l === ourRowNotLive ? " · current on chain" : ""}
                    </td>
                    <td>{l.status}</td>
                    <td>{l.quantity}</td>
                    <td>{fmtUsdg(BigInt(l.unitPrice6 || "0"))}</td>
                    <td>{fmtUtc(Number(l.endTime))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
