"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { BaseError, ContractFunctionRevertedError, RawContractError, type Abi, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";

import { CHAIN_ID, addressUrl } from "@/lib/chain";
import { CLEARINGHOUSE, SEAPORT, USDG, VAULT, ZERO_CONDUIT_KEY, seaportAbi, stockTokenAbi } from "@/lib/contracts";
import {
  SIMULATION_GAS,
  classifyFillSimulation,
  fillGasSentence,
  preflightAllowsFill,
  type FillSimulation,
  type PreflightVerdict,
} from "@/lib/fillPreflight";
import { fmtUsdg, minPremiumUsdg, shortAddress, shortHash, unitPriceUsdg } from "@/lib/format";
import { useNow, type VaultSnapshot } from "@/lib/hooks";
import { checkListingIsOurs, type ListingRow } from "@/lib/listing";
import { advancedOrderFor, fillableContracts, seaportRemaining, type SeaportFillStatus } from "@/lib/seaportOrder";
import { ConnectButton } from "./ConnectButton";
import { useNotice, useTxRunner } from "./TxToast";

/**
 * The fill card: the vault's listing, checked against the chain, simulated, and filled from here.
 *
 * THIS PAGE IS THE VENUE. The vault's calls are not listed anywhere else. The row comes from the
 * keeper's GET /orders through app/api/keeper/orders (lib/keeperOrders.ts), which has already
 * restored Seaport's counter, had Seaport hash the order and matched it to the hash the vault
 * authorised; the card checks it against the chain AGAIN here, then simulates the exact fill it
 * would send before the button is live.
 *
 * NOTHING HERE IS TRUSTED UNTIL IT HAS BEEN CHECKED AGAINST THE CHAIN. Every field of the row
 * that reaches writeContractAsync — offerer, zone, conduit, token, recipient, amount, option id,
 * order hash, end time — is first run through checkListingIsOurs() (lib/listing.ts) against the
 * addresses compiled into contracts.ts and against the values the vault itself holds on chain:
 * `listingHash()`, `listingAmount()`, `listingGrossUsdg()`, `optionId()` and `conduitKey()`, all
 * read in one multicall by useVaultSnapshot(). Until that check passes there is no approve button
 * and no fill button; the payload is shown read-only and labelled unverified. WHY: the fill
 * begins with approve(SEAPORT, cost), and Seaport refusing a tampered order at fulfilment time
 * would not undo that approval. The denominator and the quoted price are derived from the
 * components (offer[0].startAmount and the one USDG leg), never from the row's convenience
 * fields, so the number the buyer sees is the number the vault authorised. How many contracts
 * are left comes from Seaport's getOrderStatus, and how many the vault can still WRITE comes from
 * its capacity (maxContracts(totalAssets) − contractsWritten): the smaller of the two is what can
 * be bought right now.
 *
 * WRITE ON FILL. The order is PARTIAL_RESTRICTED with the vault as zone. Nothing exists in the
 * vault before the fill: Seaport calls the vault's `authorizeOrder`, which re-runs its gate
 * against TODAY's spot (band floor, premium floor plus Valorem's fee valued at spot, size on the
 * cycle's total, the clock, the halt, the oracle, the reserve) and writes exactly the filled
 * contracts into Valorem; Seaport moves them straight on to the buyer and the vault's
 * `validateOrder` confirms none stayed behind. So a fill CAN be refused after a rally, and the
 * buyer would only learn that from a reverted transaction. The card therefore simulates the very
 * AdvancedOrder it would send (lib/seaportOrder.ts advancedOrderFor, so the two cannot drift),
 * from the buyer's address, and lib/fillPreflight.ts says what the result means: a vault refusal
 * blocks the button with the vault's reason; a Seaport pre-hook refusal blocks it with Seaport's;
 * a token-transfer failure means the hook passed and the buyer's USDG approval is what is
 * missing, which the approve step fixes.
 *
 * The signature is EMPTY. The vault has no key: it validated the order on Seaport inside
 * approveListing, and Seaport skips verification for a validated order. The fee is the
 * protocol's, at harvest; the buyer pays one leg, to the vault, for exactly what they take.
 *
 * The clearinghouse the offer item must name is the one the vault was constructed with
 * (`snapshot.clear`, read from the vault), so a build whose NEXT_PUBLIC_CLEARINGHOUSE points at
 * another Clear cannot reject the vault's real listing; the compiled constant stands in only
 * until that read has landed.
 */

/** A placeholder fulfiller for a viewer without a wallet: the vault's hook runs before any
 *  transfer, so a refusal still shows; the transfer step then fails, which is expected. */
const PLACEHOLDER_FULFILLER: Address = "0x000000000000000000000000000000000000dEaD";

function revertDataOf(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  const raw = err.walk((e) => e instanceof RawContractError);
  if (raw instanceof RawContractError) {
    const d = raw.data as Hex | { data?: Hex } | undefined;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.data === "string") return d.data;
  }
  return undefined;
}

export function OrderPayload({
  listing,
  snapshot,
  seaportStatus,
}: {
  listing: ListingRow;
  /** The vault's own slot, read in one multicall: hash, count, gross, option id, conduit key,
   *  capacity, spot, policy, claim key. The check refuses to render a fill button until the row
   *  matches every one of them. */
  snapshot: VaultSnapshot;
  /** Seaport's getOrderStatus for the vault's listingHash. Used only when this row carries that
   *  hash; it then decides how many contracts are left, whatever the row says. */
  seaportStatus?: SeaportFillStatus;
}) {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const run = useTxRunner();
  const notice = useNotice();

  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);

  const expectedListingHash = snapshot.listingHash;

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
          clearinghouse: snapshot.clear ?? CLEARINGHOUSE,
          seaport: SEAPORT,
          listingHash: expectedListingHash,
          chainId: CHAIN_ID,
          amount: snapshot.listingAmount,
          grossUsdg: snapshot.listingGrossUsdg,
          optionId: snapshot.optionId,
          conduitKey: snapshot.conduitKey,
        },
        nowSeconds,
      ),
    [listing, expectedListingHash, snapshot.listingAmount, snapshot.listingGrossUsdg, snapshot.optionId, snapshot.conduitKey, snapshot.clear, nowSeconds],
  );
  const checking = check.ok && nowSeconds === 0;
  const verified = check.ok && nowSeconds > 0;

  // Size and price come from the components, which the order hash commits to. The row's
  // `quantity`/`unitPrice6` are convenience copies and are not used for anything that reaches a
  // transaction. How many are left is Seaport's figure when the page has it (fillableContracts),
  // capped at what the vault can still write: the hook re-sizes every fill against NAV.
  const total = BigInt(listing.components.offer[0]?.startAmount ?? "0");
  const gross = BigInt(listing.components.consideration[0]?.startAmount ?? "0");
  const seaportLeft = fillableContracts(listing, total, expectedListingHash, seaportStatus);
  const chainRemaining =
    expectedListingHash !== undefined && listing.orderHash.toLowerCase() === expectedListingHash.toLowerCase()
      ? seaportRemaining(total, seaportStatus)
      : undefined;
  const capacity = snapshot.capacity;
  const remaining = capacity !== undefined && capacity < seaportLeft ? capacity : seaportLeft;
  const unitPrice6 = unitPriceUsdg(gross, total) ?? 0n;

  // Plain arithmetic, recomputed per render: `remaining` is a function of the row, Seaport's
  // status and the vault's capacity, and a manual memo over it is one the React compiler cannot
  // preserve.
  const wantedCount = Number(quantity);
  const wantedBig = Number.isInteger(wantedCount) && wantedCount > 0 ? BigInt(wantedCount) : 0n;
  const want = wantedBig > remaining ? remaining : wantedBig;

  // Cost scales exactly with the fraction: gross × k / N divides cleanly because the vault
  // enforced `gross % N == 0` at approveListing, and the check has asserted it again.
  const cost = total > 0n ? (gross * want) / total : 0n;
  const firstFill = (snapshot.claimKey ?? 0n) === 0n;
  // The floor the hook applies to THIS fill at today's spot, without Valorem's fee term (off on
  // the deployed Clear). Display beside the simulation, which is the authority.
  const liveFloor = minPremiumUsdg(snapshot.spotUsdg, want, snapshot.policy);
  const strikeBelowFloor =
    snapshot.band !== undefined && snapshot.cycleStrikeUsdg !== undefined && snapshot.cycleStrikeUsdg < snapshot.band.min;

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

  // THE PRE-FLIGHT: the exact fill, simulated. Keyed on everything that changes the call; the
  // interval re-runs it against the moving spot. `structuralSharing: false` because a verdict
  // carries bigints viem's structural compare cannot walk.
  const fulfiller = address ?? PLACEHOLDER_FULFILLER;
  const preflight = useQuery({
    queryKey: ["fill-preflight", listing.orderHash, want.toString(), total.toString(), fulfiller],
    enabled: verified && want > 0n && publicClient !== undefined,
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: false,
    structuralSharing: false,
    queryFn: async (): Promise<PreflightVerdict> => {
      let sim: FillSimulation;
      try {
        await publicClient!.simulateContract({
          address: SEAPORT,
          abi: seaportAbi,
          functionName: "fulfillAdvancedOrder",
          args: [advancedOrderFor(listing.components, want, total), [], ZERO_CONDUIT_KEY, fulfiller],
          account: fulfiller,
          gas: SIMULATION_GAS,
          value: 0n,
        });
        sim = { ok: true };
      } catch (err) {
        sim = { ok: false, revertData: revertDataOf(err), message: err instanceof BaseError ? err.shortMessage : String(err) };
      }
      return classifyFillSimulation(sim);
    },
  });
  const verdict = preflight.data;
  const canFill = preflightAllowsFill(verdict);

  // Shaped for a stranger's Seaport client: the components, the hash, and the empty signature.
  // Anyone can hand it to a raw fulfillAdvancedOrder call without trusting this page's maths.
  const payloadJson = useMemo(
    () =>
      JSON.stringify(
        {
          chainId: listing.chainId,
          orderHash: listing.orderHash,
          components: listing.components,
          signature: "0x",
          note: "PARTIAL_RESTRICTED (orderType 3); offerer = zone = the vault; one USDG consideration item to the vault; validated on chain, so the signature is empty and extraData is empty. Fill with fulfillAdvancedOrder(numerator k, denominator offer[0].startAmount) after approving k × unit price of USDG to Seaport; the vault writes exactly k contracts inside the fill and re-checks its floors at that moment's spot.",
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
    if (!verified || !address || want === 0n || !canFill) return;
    setBusy(true);
    try {
      if ((usdgAllowance ?? 0n) < cost) {
        // Seaport pulls directly — the vault's conduit key is zero and the check has confirmed the
        // order carries it — so the approval goes to Seaport itself, never to a conduit.
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

      // The same struct the pre-flight simulated. Every address and amount in it has passed
      // checkListingIsOurs() against the chain; the signature is empty by construction.
      await run(
        () =>
          writeContractAsync({
            address: SEAPORT,
            abi: seaportAbi as unknown as Abi,
            functionName: "fulfillAdvancedOrder",
            args: [advancedOrderFor(listing.components, want, total), [], ZERO_CONDUIT_KEY, address as Address],
            value: 0n,
          }),
        { pending: "Filling the listing", success: "Filled — the vault wrote the calls and the option tokens are in your wallet" },
      );
      await Promise.all([buyerReads.refetch(), preflight.refetch()]);
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
            ? "The vault's order · fill from here"
            : checking
              ? "The vault's order · checking against the chain"
              : "Order from the keeper · unverified"}
        </span>
        <span className="tiny faint mono">status {listing.status}</span>
      </div>

      {!check.ok ? (
        <div className="notice" data-tone="bad" style={{ marginBottom: 12 }}>
          <strong>This order did not check out against the chain, so it cannot be filled from here.</strong>
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
            {remaining.toString()} buyable now · {seaportLeft.toString()} of {total.toString()} unsold per Seaport
            {capacity !== undefined ? ` · vault capacity ${capacity.toString()}` : ""}
          </span>
        </div>
        <div className="row">
          <span className="k">Unit price</span>
          <span className="v">{fmtUsdg(unitPrice6, 6)} USDG per contract</span>
        </div>
        {/* The recipient is printed from OUR constant when the listing is verified — the check
            has already proven it equal — and from the row, marked as such, when it is not. */}
        <div className="row">
          <span className="k">Payment leg · consideration[0]</span>
          <span className="v">
            {fmtUsdg(gross)} USDG →{" "}
            {verified
              ? `the vault ${shortAddress(VAULT)}`
              : `${shortAddress(listing.components.consideration[0]?.recipient)} (as served)`}
          </span>
        </div>
        <div className="row">
          <span className="k">Order type · zone</span>
          <span className="v">
            {listing.components.orderType === 3 ? "PARTIAL_RESTRICTED" : `type ${listing.components.orderType}`} ·{" "}
            {verified ? "the vault" : `${shortAddress(listing.components.zone)} (as served)`}
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
              <span className="v">{want.toString()} option ERC-1155, written for you inside the fill</span>
            </div>
            <div className="row" title="Policy.minPremium at the feed's current spot, the floor the vault's fill hook applies to this size. Valorem's engine fee, off on the deployed clearinghouse, would be added on top.">
              <span className="k">Vault floor for this size, live</span>
              <span className="v">
                {liveFloor === undefined
                  ? snapshot.spotStale
                    ? "spot stale — the vault will not sell"
                    : "—"
                  : `${fmtUsdg(liveFloor)} USDG${cost < liveFloor ? " · above what this fill pays" : ""}`}
              </span>
            </div>
            <div className="row">
              <span className="k">Your USDG</span>
              <span className="v">{fmtUsdg(usdgBalance)}</span>
            </div>
          </div>

          {strikeBelowFloor ? (
            <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
              Spot has rallied: this week&apos;s strike ({fmtUsdg(snapshot.cycleStrikeUsdg)} USDG) is now below the
              vault&apos;s minimum of {fmtUsdg(snapshot.band?.min)} USDG. The fill hook re-checks that floor at every
              sale, so the vault will refuse this fill until the keeper reprices or spot falls back.
            </div>
          ) : null}

          <PreflightNotice verdict={verdict} pending={preflight.isPending && want > 0n} placeholder={address === undefined} />

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
                disabled={busy || want === 0n || insufficient || !canFill || listing.status === "cancelled"}
                onClick={fill}
              >
                {busy ? "Working…" : `Fill ${want.toString()} contract${want === 1n ? "" : "s"}`}
              </button>
            )}
            <button data-variant="ghost" onClick={copyPayload}>
              Copy order JSON
            </button>
          </div>

          <p className="tiny faint" style={{ marginTop: 12 }}>
            {fillGasSentence(firstFill)} This calls Seaport 1.6 directly at{" "}
            <a href={addressUrl(SEAPORT)} target="_blank" rel="noreferrer noopener">
              {shortAddress(SEAPORT)}
            </a>{" "}
            with an empty signature and no conduit: the vault validated the order on chain. The exercise window closes at
            the option&apos;s expiry; after that an unexercised call is worth nothing.
          </p>
        </>
      ) : checking ? (
        <p className="tiny faint" style={{ marginTop: 12 }}>
          Checking this order against the chain…
        </p>
      ) : (
        <p className="tiny faint" style={{ marginTop: 12 }}>
          Nothing on this card sends a transaction. The payload below is shown as the keeper served it, for the
          record; it has not been verified against the vault and should not be filled.
        </p>
      )}

      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          {verified ? "Raw order payload" : checking ? "Raw payload from the keeper" : "Raw payload from the keeper (unverified)"}
        </summary>
        <pre className="payload" style={{ marginTop: 10 }}>
          {payloadJson}
        </pre>
      </details>
    </div>
  );
}

/** What the simulation said, in the tone it deserves: a vault refusal is the one that blocks. */
function PreflightNotice({ verdict, pending, placeholder }: { verdict: PreflightVerdict | undefined; pending: boolean; placeholder: boolean }) {
  if (verdict === undefined) {
    return pending ? (
      <p className="tiny faint" style={{ marginTop: 12 }}>
        Simulating this fill against the chain…
      </p>
    ) : null;
  }
  switch (verdict.kind) {
    case "ok":
      return (
        <div className="notice" data-tone="info" style={{ marginTop: 12 }}>
          <strong>Simulation passed.</strong> The vault accepts this size at today&apos;s spot and Seaport would deliver the
          contracts.
        </div>
      );
    case "buyerSide":
      return (
        <div className="notice" data-tone="info" style={{ marginTop: 12 }}>
          <strong>The vault&apos;s checks pass at today&apos;s spot.</strong>{" "}
          {placeholder
            ? "The simulation ran from a placeholder address, so the payment step failed as expected; connect a wallet for a full check."
            : `${verdict.decoded.text} Approve USDG to Seaport (the first step of the button below) and the fill should go through.`}
        </div>
      );
    case "vaultRefused":
      return (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          <strong>The vault would refuse this fill right now{verdict.decoded.name ? ` (${verdict.decoded.name})` : ""}.</strong>{" "}
          {verdict.decoded.text} The button stays off until a simulation passes; this page re-simulates every few
          seconds.
        </div>
      );
    case "seaportRefused":
      return (
        <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
          <strong>Seaport would refuse this fill{verdict.decoded.name ? ` (${verdict.decoded.name})` : ""}.</strong>{" "}
          {verdict.decoded.text}
        </div>
      );
    case "tokenRefused":
      return (
        <div className="notice" data-tone="bad" style={{ marginTop: 12 }}>
          <strong>USDG would not move for this fill{verdict.decoded.name ? ` (${verdict.decoded.name})` : ""}.</strong>{" "}
          {verdict.decoded.text} The vault&apos;s own checks were not the problem; the button stays off until USDG
          moves again, and this page re-simulates every few seconds.
        </div>
      );
    case "inconclusive":
      return (
        <div className="notice" data-tone="warn" style={{ marginTop: 12 }}>
          <strong>The simulation could not say whether the vault would accept this fill.</strong> {verdict.text} The
          button is left on; your wallet will show the real outcome before you sign.
        </div>
      );
  }
}
