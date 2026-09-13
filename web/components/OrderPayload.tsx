"use client";

import { useMemo, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";

import type { OvercallListing } from "@/lib/api";
import { CHAIN_ID, addressUrl } from "@/lib/chain";
import {
  CLEARINGHOUSE,
  OVERCALL_FEE_RECIPIENT,
  SEAPORT,
  USDG,
  VAULT,
  ZERO_CONDUIT_KEY,
  seaportAbi,
  stockTokenAbi,
} from "@/lib/contracts";
import { fmtUsdg, shortAddress, shortHash, splitPremium } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { checkListingIsOurs } from "@/lib/overcall";
import { ConnectButton } from "./ConnectButton";
import { useNotice, useTxRunner } from "./TxToast";

/**
 * The fallback fill path.
 *
 * If Overcall's own front end does not surface our listing, an invisible listing is an unfilled
 * week. So this panel publishes the signed order verbatim — the exact JSON their API returns,
 * which is everything a buyer needs to call Seaport themselves — and offers to send the fill
 * from this page.
 *
 * NOTHING HERE IS TRUSTED UNTIL IT HAS BEEN CHECKED AGAINST THE CHAIN. The listing prop is a
 * row from overcall.finance's database, relayed by our proxy. Every field of it that reaches
 * writeContractAsync — offerer, zone, conduit, both tokens, both recipients, both amounts, the
 * option id, the order hash, the end time — is first run through checkListingIsOurs() against
 * the addresses compiled into contracts.ts and against four values the vault itself holds on
 * chain: `expectedListingHash` (listingHash()), `expectedListingAmount` (listingAmount()),
 * `expectedListingGrossUsdg` (listingGrossUsdg()) and `expectedOptionId` (optionId()), all read
 * in one multicall by useVaultSnapshot(). Until that check passes there is no approve button
 * and no fill button; the payload is shown read-only and labelled unverified. WHY: the fill
 * begins with approve(SEAPORT, cost), and EIP-1271 rejecting a tampered hash at fulfilment
 * time would not undo that approval. The hash alone would not be enough either: Overcall's
 * `orderHash` is their string, and a row that kept it but carried ten-times-the-price
 * components would be quoted and approved at that price before Seaport ever recomputed the
 * hash. So the contract count, the gross price and the option id are compared to the chain's
 * numbers, not merely to each other. The denominator and the quoted price are derived from
 * the signed components (offer[0].startAmount and the two legs), never from the row's
 * convenience fields, so the number the buyer sees is the number the vault authorised.
 *
 * The fill goes through `fulfillAdvancedOrder` with numerator/denominator, because every
 * Overcall listing is orderType 1 (PARTIAL_OPEN) and a buyer may want k of N contracts. That
 * partial fill only works because the premium legs were rounded PER CONTRACT when the order was
 * built: each consideration amount is an exact multiple of N, so scaling by k/N stays exact and
 * Seaport does not revert with InexactFraction. The check above asserts that rounding too.
 *
 * Two fields read wrong if you do not know the machinery:
 *   signature  a 65-byte placeholder. The vault is the offerer and authorises the listing by
 *              hash on-chain (EIP-1271), so there is no key behind this value. Its contents are
 *              irrelevant; only its shape is checked, by Seaport and by Overcall's schema.
 *   endTime    the option's exerciseTimestamp — Friday book close, NOT Saturday expiry. The
 *              listing dies when the book closes even though the option lives a day longer.
 */
export function OrderPayload({
  listing,
  expectedListingHash,
  expectedListingAmount,
  expectedListingGrossUsdg,
  expectedOptionId,
}: {
  listing: OvercallListing;
  /** The vault's listingHash() as read from the chain: undefined until read, zero when empty. */
  expectedListingHash: Hex | undefined;
  /** The vault's listingAmount(), listingGrossUsdg() and optionId() from the same read. Each is
   *  asserted when present; a caller without them gets the weaker hash-only check. */
  expectedListingAmount?: bigint;
  expectedListingGrossUsdg?: bigint;
  expectedOptionId?: bigint;
}) {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const notice = useNotice();

  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);

  // The clock lives here, not in the lib, so the check stays a pure function of its inputs.
  // useNow() is 0 until the component has mounted; until then nothing is "verified" — an
  // endTime compared against 0 proves nothing — and no control is rendered. That first frame
  // is `checking`, not "unverified": the card must not claim a result no check has produced.
  const nowSeconds = useNow();
  const check = useMemo(
    () =>
      checkListingIsOurs(
        listing,
        {
          vault: VAULT,
          usdg: USDG,
          clearinghouse: CLEARINGHOUSE,
          seaport: SEAPORT,
          listingHash: expectedListingHash,
          chainId: CHAIN_ID,
          amount: expectedListingAmount,
          grossUsdg: expectedListingGrossUsdg,
          optionId: expectedOptionId,
        },
        nowSeconds,
      ),
    [listing, expectedListingHash, expectedListingAmount, expectedListingGrossUsdg, expectedOptionId, nowSeconds],
  );
  const checking = check.ok && nowSeconds === 0;
  const verified = check.ok && nowSeconds > 0;

  // Size and price come from the signed components, which the order hash commits to. The row's
  // `quantity`/`unitPrice6` are Overcall's convenience copies and are not used for anything that
  // reaches a transaction. `remaining` is theirs and only caps the input; Seaport enforces it.
  const total = BigInt(listing.components.offer[0]?.startAmount ?? "0");
  const writerLeg = BigInt(listing.components.consideration[0]?.startAmount ?? "0");
  const feeLeg = BigInt(listing.components.consideration[1]?.startAmount ?? "0");
  const claimedRemaining = /^[0-9]+$/.test(listing.remaining ?? "") ? BigInt(listing.remaining) : total;
  const remaining = claimedRemaining > total ? total : claimedRemaining;
  const unitPrice6 = total > 0n ? (writerLeg + feeLeg) / total : 0n;

  const want = useMemo(() => {
    const n = Number(quantity);
    if (!Number.isInteger(n) || n <= 0) return 0n;
    const asBig = BigInt(n);
    return asBig > remaining ? remaining : asBig;
  }, [quantity, remaining]);

  // Cost scales exactly with the fraction: consideration[i] * k / N, and both legs divide
  // cleanly because they were built as perContract * N — the check has already asserted so.
  const cost = total > 0n ? ((writerLeg + feeLeg) * want) / total : 0n;
  const split = splitPremium(unitPrice6, want);

  const buyerReads = useReadContracts({
    contracts:
      address !== undefined
        ? [
            { address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [address] },
            {
              address: USDG,
              abi: stockTokenAbi as unknown as Abi,
              functionName: "allowance",
              args: [address, SEAPORT],
            },
          ]
        : [],
    allowFailure: true,
    query: { enabled: address !== undefined, refetchInterval: 20_000 },
  });

  const usdgBalance =
    buyerReads.data?.[0]?.status === "success" ? (buyerReads.data[0].result as bigint) : undefined;
  const usdgAllowance =
    buyerReads.data?.[1]?.status === "success" ? (buyerReads.data[1].result as bigint) : undefined;

  // Shaped for a stranger's Seaport client: exactly the fields Overcall's API serves, uints as
  // decimal strings, nothing recomputed. Anyone can hand it to a raw fulfillAdvancedOrder call
  // without trusting this page's maths.
  const payloadJson = useMemo(
    () =>
      JSON.stringify(
        {
          chainId: listing.chainId,
          orderHash: listing.orderHash,
          components: listing.components,
          signature: listing.signature,
        },
        null,
        2,
      ),
    [listing],
  );

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payloadJson);
      notice("success", "Order payload copied");
    } catch {
      notice("error", "Could not copy", "Select the JSON below and copy it manually.");
    }
  }

  async function fill() {
    // The buttons are not rendered when the check fails; this is the belt to that brace.
    if (!verified || !address || want === 0n) return;
    setBusy(true);
    try {
      if ((usdgAllowance ?? 0n) < cost) {
        // Seaport pulls directly — conduitKey is zero on every Overcall order, and the check
        // above has confirmed it on this one — so the approval goes to Seaport itself, never to
        // a conduit.
        const approved = await run(
          () =>
            writeContractAsync({
              address: USDG,
              abi: stockTokenAbi as unknown as Abi,
              functionName: "approve",
              args: [SEAPORT, cost],
            }),
          { pending: "Approving USDG to Seaport", success: "USDG approved" },
        );
        if (!approved) return;
      }

      // Overcall's JSON carries every uint as a decimal string; Seaport wants uint256, so each
      // field is converted explicitly rather than passed through a generic reviver. Every
      // address and amount below has passed checkListingIsOurs() against the chain.
      const parameters = {
        offerer: listing.components.offerer,
        zone: listing.components.zone,
        offer: listing.components.offer.map((item) => ({
          itemType: item.itemType,
          token: item.token,
          identifierOrCriteria: BigInt(item.identifierOrCriteria),
          startAmount: BigInt(item.startAmount),
          endAmount: BigInt(item.endAmount),
        })),
        consideration: listing.components.consideration.map((item) => ({
          itemType: item.itemType,
          token: item.token,
          identifierOrCriteria: BigInt(item.identifierOrCriteria),
          startAmount: BigInt(item.startAmount),
          endAmount: BigInt(item.endAmount),
          recipient: item.recipient,
        })),
        orderType: listing.components.orderType,
        startTime: BigInt(listing.components.startTime),
        endTime: BigInt(listing.components.endTime),
        zoneHash: listing.components.zoneHash,
        salt: BigInt(listing.components.salt),
        conduitKey: listing.components.conduitKey,
        // OrderParameters carries totalOriginalConsiderationItems where OrderComponents carries
        // `counter`. Overcall stores components, so this field is reconstructed — and it must
        // equal the full consideration length or the derived order hash will not match.
        totalOriginalConsiderationItems: BigInt(listing.components.consideration.length),
      };

      await run(
        () =>
          writeContractAsync({
            address: SEAPORT,
            abi: seaportAbi as unknown as Abi,
            functionName: "fulfillAdvancedOrder",
            args: [
              {
                parameters,
                numerator: want,
                denominator: total,
                signature: listing.signature,
                extraData: "0x" as Hex,
              },
              [],
              ZERO_CONDUIT_KEY,
              address as Address,
            ],
            value: 0n,
          }),
        { pending: "Filling the listing", success: "Filled — option tokens are in your wallet" },
      );
      await buyerReads.refetch();
    } finally {
      setBusy(false);
    }
  }

  const insufficient = usdgBalance !== undefined && cost > usdgBalance;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">
          {verified
            ? "Signed order · fill from here"
            : checking
              ? "Order on Overcall's book · checking against the chain"
              : "Order on Overcall's book · unverified"}
        </span>
        <span className="tiny faint mono">status {listing.status}</span>
      </div>

      {!check.ok ? (
        <div className="notice" data-tone="bad" style={{ marginBottom: 12 }}>
          <strong>This listing did not check out against the chain, so it cannot be filled from here.</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {check.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rows">
        <div className="row">
          <span className="k">Order hash</span>
          <span className="v">{shortHash(listing.orderHash)}</span>
        </div>
        <div className="row">
          <span className="k">Contracts</span>
          <span className="v">
            {remaining.toString()} left of {total.toString()}
          </span>
        </div>
        <div className="row">
          <span className="k">Unit price</span>
          <span className="v">{fmtUsdg(unitPrice6)} USDG per contract</span>
        </div>
        {/* Recipients are printed from OUR constants when the listing is verified — the check
            has already proven them equal — and from the row, marked as such, when it is not. */}
        <div className="row">
          <span className="k">Writer leg · consideration[0]</span>
          <span className="v">
            {fmtUsdg(writerLeg)} USDG →{" "}
            {verified
              ? shortAddress(VAULT)
              : `${shortAddress(listing.components.consideration[0]?.recipient)} (as listed)`}
          </span>
        </div>
        <div className="row">
          <span className="k">Overcall fee leg · consideration[1]</span>
          <span className="v">
            {fmtUsdg(feeLeg)} USDG →{" "}
            {verified ? (
              <a href={addressUrl(OVERCALL_FEE_RECIPIENT)} target="_blank" rel="noreferrer noopener">
                {shortAddress(OVERCALL_FEE_RECIPIENT)}
              </a>
            ) : (
              `${shortAddress(listing.components.consideration[1]?.recipient)} (as listed)`
            )}
          </span>
        </div>
        <div className="row">
          <span className="k">Fee rounding</span>
          <span className="v">
            {fmtUsdg(split.feePerContract6, 6)} + {fmtUsdg(split.writerPerContract6, 6)} per contract
          </span>
        </div>
      </div>

      {verified ? (
        <>
          <hr className="hr" />

          <div className="field">
            <label htmlFor="fill-qty">Contracts to buy</label>
            <div className="input-wrap">
              <input
                id="fill-qty"
                type="text"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ""))}
              />
              <span className="suffix">of {remaining.toString()}</span>
            </div>
          </div>

          <div className="rows" style={{ marginTop: 12 }}>
            <div className="row">
              <span className="k">You pay</span>
              <span className="v">{fmtUsdg(cost)} USDG</span>
            </div>
            <div className="row">
              <span className="k">You receive</span>
              <span className="v">{want.toString()} option ERC-1155</span>
            </div>
            <div className="row">
              <span className="k">Your USDG</span>
              <span className="v">{fmtUsdg(usdgBalance)}</span>
            </div>
          </div>

          {insufficient ? (
            <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
              Not enough USDG in the wallet for that many contracts.
            </div>
          ) : null}

          <div className="btn-row" style={{ marginTop: 14 }}>
            {!isConnected ? (
              <ConnectButton />
            ) : (
              <button
                data-variant="primary"
                disabled={busy || want === 0n || insufficient || listing.status === "cancelled"}
                onClick={fill}
              >
                {busy ? "Working…" : `Fill ${want.toString()} contract${want === 1n ? "" : "s"}`}
              </button>
            )}
            <button data-variant="ghost" onClick={copyPayload}>
              Copy signed order JSON
            </button>
          </div>

          <p className="tiny faint" style={{ marginTop: 12 }}>
            This calls Seaport 1.6 directly at{" "}
            <a href={addressUrl(SEAPORT)} target="_blank" rel="noreferrer noopener">
              {shortAddress(SEAPORT)}
            </a>{" "}
            with no conduit, exactly as Overcall&apos;s own front end does. The exercise window
            closes at the option&apos;s expiry; after that an unexercised call is worth nothing.
          </p>
        </>
      ) : checking ? (
        <p className="tiny faint" style={{ marginTop: 12 }}>
          Checking this listing against the chain…
        </p>
      ) : (
        <p className="tiny faint" style={{ marginTop: 12 }}>
          Nothing on this card sends a transaction. The payload below is shown as Overcall served
          it, for the record; it has not been verified against the vault and should not be filled.
        </p>
      )}

      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          {verified
            ? "Raw signed order payload"
            : checking
              ? "Raw payload from Overcall"
              : "Raw payload from Overcall (unverified)"}
        </summary>
        <pre className="payload" style={{ marginTop: 10 }}>
          {payloadJson}
        </pre>
      </details>
    </div>
  );
}
