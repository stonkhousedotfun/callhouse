"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BaseError, type Abi, type Address } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { Button, Card, CardHead, CardMeta, CardTitle, ExternalLink, Field, Notice, Row, Rows, Unit } from "@/components/ui";
import { CHAIN_ID, addressUrl } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { ASSET, MARKET, USDG, VAULT, stockTokenAbi, valoremClearAbi, vaultAbi } from "@/lib/contracts";
import {
  approvalFor,
  classifyExerciseSimulation,
  describeExerciseError,
  exerciseAllowed,
  exerciseAmounts,
  exerciseAssetsMatch,
  exerciseButton,
  exerciseSendable,
  exerciseWindow,
  fmtNvdaExact,
  fmtUsdgExact,
  parseContracts,
  revertDataOf,
  spotCheck,
  spotNeedsConfirmation,
  type ExerciseAmounts,
  type SpotCheck,
  type ExerciseBlocker,
  type ExerciseVerdict,
  type ExerciseWindow,
} from "@/lib/exercise";
import { fmtEastern, fmtUtc, shortAddress } from "@/lib/format";
import { useChainTime, useExercisePosition, type VaultSnapshot } from "@/lib/hooks";
import { useNotice, useTxRunner } from "./TxToast";

/**
 * The Exercise card on the cycle page: a holder of this week's option exercises it from here.
 *
 * WHO SEES IT. Only a connected wallet whose balance of the option ERC-1155 (the clearinghouse's
 * token id `vault.optionId()`) is above zero. Everyone else gets nothing rendered, so the buy
 * side's column stays `:empty` and the page's layout is unchanged for them.
 *
 * WHAT IS READ, AND FROM WHERE (lib/hooks.ts useExercisePosition). The clearinghouse is the one the
 * vault names (`vault.clear()`), because that is where the exercise is sent. The strike, the lot
 * and the window are that clearinghouse's own tuple for the id, not the keeper's data and not the
 * vault's snapshot. The clock is the chain's latest block (useChainTime), not the device's; see
 * lib/exercise.ts for why and for the one-block lag at expiry. Spot for the warning is the vault's
 * `spotUsdg()`, the figure the rest of the cycle page shows.
 *
 * THE FLOW. Pick a whole number of contracts up to the balance. The card simulates
 * `exercise(optionId, amount)` from the wallet and says what the result means
 * (classifyExerciseSimulation). The button is live only inside the window and on a verdict that
 * allows it (exerciseButton). A click simulates once more; if the USDG allowance to the
 * clearinghouse is below the exact total (the strike cost plus the clearinghouse's fee when its fee
 * switch is on), it sends `USDG.approve(clearinghouse, total)`, exactly that amount and never
 * unlimited, and simulates again; only then `exercise(optionId, amount)`. When spot is at or below
 * the strike, or cannot be read, the card warns and the button waits for an explicit confirmation.
 * That confirmation is tied to the verdict and the amount it was given for: a changed verdict or
 * amount needs a new tick. Right before the exercise is sent, spot is read again from the vault,
 * and a verdict that now needs a confirmation the holder did not give stops the send. Both writes
 * are pinned to this app's chain, and the button stays off while the wallet is on another one.
 *
 * TEST HOOKS (W-13, tests/acceptance/fork.acceptance.ts): the card is `data-slot="card"` with the
 * title "Exercise" and id `exercise`; figures are `row`/`k`/`v`; notices are `notice`. The amount
 * field is `#exercise-amount`, the confirmation `#exercise-confirm`, the button `#exercise-submit`
 * with the accessible name "Exercise N contracts", and the line under it `#exercise-hint`.
 */
export function ExercisePanel({ snapshot }: { snapshot: VaultSnapshot }) {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const run = useTxRunner();
  const notice = useNotice();
  const chain = useChainTime();
  const { data: pos, refetch: refetchPosition } = useExercisePosition(snapshot, address);

  // `null` until the holder types: the field then shows the whole balance.
  const [typed, setTyped] = useState<string | null>(null);
  // The confirmation is stored against the spot verdict and the amount it was given for, so a
  // verdict that changes (unreadable -> at or below the strike) or a new amount needs a new tick.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const balance = pos.optionBalance;
  const raw = typed ?? (balance === undefined ? "" : balance.toString());
  const amount = parseContracts(raw);
  const windowState = exerciseWindow(pos, chain.timestamp);
  const assetsMatch = exerciseAssetsMatch(pos, { usdg: USDG, asset: ASSET });
  const amounts = exerciseAmounts({
    amount,
    strikeUsdg: pos.strikeUsdg,
    underlyingAmount: pos.underlyingAmount,
    feesEnabled: pos.feesEnabled,
    feeBps: pos.feeBps,
  });
  // The spot check needs a size; with no valid amount typed it is asked for one contract.
  const checkAmounts =
    amounts ??
    exerciseAmounts({ amount: 1n, strikeUsdg: pos.strikeUsdg, underlyingAmount: pos.underlyingAmount, feesEnabled: pos.feesEnabled, feeBps: pos.feeBps });
  const spot = snapshot.spotStale ? undefined : snapshot.spotUsdg;
  const check = spotCheck(spot, checkAmounts);
  const needsConfirmation = spotNeedsConfirmation(check);
  const confirmKey = confirmationKey(check, amount);
  const confirmed = confirmedFor === confirmKey;

  const clear = pos.clear;
  const optionId = pos.optionId;
  const holder = address;

  async function simulate(forAmount: bigint, total: bigint, allowance: bigint | undefined): Promise<ExerciseVerdict> {
    try {
      await publicClient!.simulateContract({
        address: clear as Address,
        abi: valoremClearAbi as unknown as Abi,
        functionName: "exercise",
        args: [optionId, forAmount],
        account: holder,
      });
      return classifyExerciseSimulation({ ok: true }, { total, usdgBalance: pos.usdgBalance, allowance });
    } catch (err) {
      return classifyExerciseSimulation(
        { ok: false, revertData: revertDataOf(err), message: err instanceof BaseError ? err.shortMessage : String(err) },
        { total, usdgBalance: pos.usdgBalance, allowance },
      );
    }
  }

  // THE PRE-FLIGHT: this exact exercise, from this wallet, simulated. Keyed on everything that
  // changes its outcome, so a new amount, an approval or a USDG top-up has no verdict until its
  // own eth_call returns. Only inside the window: before it, the clearinghouse's answer is known.
  const simulable =
    windowState === "open" &&
    assetsMatch === true &&
    clear !== undefined &&
    optionId !== undefined &&
    holder !== undefined &&
    amount !== undefined &&
    balance !== undefined &&
    amount <= balance &&
    amounts !== undefined &&
    pos.usdgBalance !== undefined &&
    pos.usdgAllowance !== undefined &&
    publicClient !== undefined;
  const preflight = useQuery({
    queryKey: [
      "exercise-preflight",
      clear,
      optionId?.toString(),
      amount?.toString(),
      holder,
      amounts?.total.toString(),
      pos.usdgAllowance?.toString(),
      pos.usdgBalance?.toString(),
    ],
    enabled: simulable,
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: false,
    structuralSharing: false,
    queryFn: () => simulate(amount!, amounts!.total, pos.usdgAllowance),
  });
  const verdict = simulable ? preflight.data : undefined;

  const button = exerciseButton({
    busy,
    connected: isConnected && holder !== undefined,
    onChain: walletChainId === CHAIN_ID,
    window: windowState,
    assetsMatch,
    optionBalance: balance,
    amount,
    amounts,
    usdgBalance: pos.usdgBalance,
    allowance: pos.usdgAllowance,
    verdict,
    needsConfirmation,
    confirmed,
  });

  async function exercise() {
    if (!button.enabled || holder === undefined || clear === undefined || optionId === undefined) return;
    if (amount === undefined || amounts === undefined || publicClient === undefined) return;
    const clearAddress = clear;
    const id = optionId;
    const count = amount;
    const total = amounts.total;
    const exercising = amounts;
    // The confirmation as it stood at the click; the send below is checked against it.
    const givenFor = confirmedFor;
    setBusy(true);
    try {
      // Simulate again before anything is sent: the verdict on screen can be an interval old.
      const fresh = await preflight.refetch();
      if (!exerciseAllowed(fresh.data)) {
        notice("error", "Exercise not sent", verdictSentence(fresh.data, total, pos.usdgBalance));
        return;
      }
      const approval = approvalFor(pos.usdgAllowance, total);
      if (approval === undefined) return;
      if (approval > 0n) {
        // Exactly the total, to the clearinghouse that pulls it. Never unlimited.
        const approved = await run(
          () =>
            writeContractAsync({
              address: USDG,
              abi: stockTokenAbi as unknown as Abi,
              functionName: "approve",
              args: [clearAddress, approval],
              chainId: CHAIN_ID,
            }),
          { pending: "Approving USDG to the clearinghouse", success: "USDG approved" },
        );
        if (!approved) return;
        // With the approval in place the exercise must now pass outright.
        const after = await simulate(count, total, approval);
        if (!exerciseSendable(after)) {
          notice("error", "Exercise not sent", verdictSentence(after, total, pos.usdgBalance));
          await refetchPosition();
          return;
        }
      }
      // Spot again, from the vault, right before the exercise: an approval can take minutes, and the
      // verdict the holder saw (or confirmed) can be stale by now.
      const spotNow = await freshSpotCheck(exercising);
      if (spotNeedsConfirmation(spotNow) && givenFor !== confirmationKey(spotNow, count)) {
        notice(
          "error",
          "Exercise not sent",
          spotNow === "unknown"
            ? "Spot could not be read right before sending, so this page cannot tell whether exercising is worth it. Nothing more was sent; confirm on the card and try again."
            : `At the vault's spot right now, exercising costs at least as much as the ${MARKET} is worth. Nothing more was sent; confirm on the card and try again.`,
        );
        await refetchPosition();
        return;
      }
      const hash = await run(
        async () => {
          try {
            return await writeContractAsync({
              address: clearAddress,
              abi: valoremClearAbi as unknown as Abi,
              functionName: "exercise",
              args: [id, count],
              chainId: CHAIN_ID,
            });
          } catch (err) {
            const text = describeExerciseError(err);
            throw text === undefined ? err : new Error(text);
          }
        },
        {
          pending: `Exercising ${count.toString()} contract${count === 1n ? "" : "s"}`,
          success: `Exercised: ${fmtNvdaExact(amounts.nvdaOut)} ${MARKET} is in your wallet`,
        },
      );
      if (hash) {
        setTyped(null);
        setConfirmedFor(null);
      }
      await Promise.all([refetchPosition(), chain.refetch()]);
    } finally {
      setBusy(false);
    }
  }

  /** The vault's `spotUsdg()` read now, checked against these amounts; "unknown" when it reverts. */
  async function freshSpotCheck(forAmounts: ExerciseAmounts): Promise<SpotCheck> {
    if (VAULT === undefined || publicClient === undefined) return spotCheck(undefined, forAmounts);
    try {
      const spotNow = (await publicClient.readContract({
        address: VAULT,
        abi: vaultAbi as unknown as Abi,
        functionName: "spotUsdg",
      })) as bigint;
      return spotCheck(spotNow, forAmounts);
    } catch {
      return spotCheck(undefined, forAmounts);
    }
  }

  if (!isConnected || holder === undefined || balance === undefined || balance === 0n) return null;

  const meta =
    windowState === "open"
      ? "window open"
      : windowState === "before"
        ? `opens ${fmtUtc(pos.exerciseTs)}`
        : windowState === "expired"
          ? "expired"
          : "reading the chain clock";

  return (
    <Card as="section" id="exercise" aria-labelledby="exercise-title" className="@container">
      <CardHead>
        <CardTitle id="exercise-title">Exercise</CardTitle>
        <CardMeta>{meta}</CardMeta>
      </CardHead>

      <Rows>
        <Row
          k="Options in this wallet"
          v={
            <>
              {balance.toString()} <Unit>contract{balance === 1n ? "" : "s"}</Unit>
            </>
          }
        />
        <Row
          k="Strike, per contract"
          className={STACK_360}
          v={
            <>
              {fmtUsdgExact(pos.strikeUsdg)} <Unit>USDG</Unit>
            </>
          }
        />
        <Row
          title="The option's underlyingAmount on the clearinghouse: what one contract delivers."
          k={`${MARKET} received per contract`}
          v={
            <>
              {fmtNvdaExact(pos.underlyingAmount)} <Unit>{MARKET}</Unit>
            </>
          }
        />
        <Row
          title="The option's exerciseTimestamp on the clearinghouse. Exercise is accepted from this moment."
          k="Exercise opens"
          className={STACK_540}
          v={
            <>
              <span className="whitespace-nowrap">{fmtUtc(pos.exerciseTs)}</span> ·{" "}
              <span className="whitespace-nowrap">{fmtEastern(pos.exerciseTs)}</span>
            </>
          }
        />
        <Row
          title="The option's expiryTimestamp on the clearinghouse. Exercise is refused from this moment."
          k="Expires"
          className={STACK_540}
          v={
            <>
              <span className="whitespace-nowrap">{fmtUtc(pos.expiryTs)}</span> ·{" "}
              <span className="whitespace-nowrap">{fmtEastern(pos.expiryTs)}</span>
            </>
          }
        />
      </Rows>

      {assetsMatch === false ? (
        <Notice tone="danger" className="mt-4" title={<>This option does not settle in USDG for {MARKET}.</>}>
          The clearinghouse&apos;s tuple for this id names other tokens than the ones this page approves and expects,
          so nothing can be exercised from here.
        </Notice>
      ) : null}

      {windowState === "expired" ? (
        <Notice tone="warn" className="mt-4" title={<>These options expired worthless.</>}>
          They expired at {fmtUtc(pos.expiryTs)} · {fmtEastern(pos.expiryTs)} without being exercised. The
          clearinghouse no longer accepts exercise for them, and there is nothing left to do with them.
        </Notice>
      ) : windowState === "unknown" ? (
        <p className="mt-4 text-[12.5px] leading-[1.55] text-ink-3">Reading the option and the chain&apos;s clock…</p>
      ) : (
        <>
          {windowState === "before" ? (
            <Notice
              tone="info"
              className="mt-4"
              title={
                <>
                  Exercise opens at {fmtUtc(pos.exerciseTs)} · {fmtEastern(pos.exerciseTs)}.
                </>
              }
            >
              The clearinghouse accepts exercise from the option&apos;s exercise time until its expiry. The button stays
              off until the chain&apos;s latest block reaches the exercise time; this page reads the chain&apos;s clock,
              not your device&apos;s.
            </Notice>
          ) : null}

          <div className="mt-5 border-t border-line pt-5">
            <Field
              id="exercise-amount"
              label={<>Contracts to exercise</>}
              inputMode="numeric"
              value={raw}
              disabled={busy}
              // The raw text, never "cleaned": "1.5" must read as no amount, not as 15.
              onChange={(e) => setTyped(e.target.value)}
              suffix={<>of {balance.toString()}</>}
            />

            <Rows className="mt-3 rounded-md bg-surface-2 px-4 py-1">
              <Row
                title="What the clearinghouse pulls from this wallet: the strike cost plus its fee. The USDG approval is for exactly this."
                k="You pay"
                v={
                  amounts === undefined ? (
                    "—"
                  ) : (
                    <>
                      <span className="text-[20px] font-semibold leading-none sm:text-[22px]">{fmtUsdgExact(amounts.total)}</span>{" "}
                      <small className="text-[12.5px] font-medium text-ink-3">USDG</small>
                    </>
                  )
                }
                className={cn("py-3.5! [&>dt]:font-semibold [&>dt]:text-ink", STACK_360)}
              />
              <Row k="Strike cost" v={usdgOrDash(amounts?.strikeCost)} dense />
              <Row
                title={
                  pos.feesEnabled === true
                    ? `The clearinghouse's fee switch is on: ${String(pos.feeBps ?? "?")} basis points of the strike cost, rounded down, and at least 1 base unit.`
                    : "The clearinghouse's fee switch is off, so it charges nothing on exercise."
                }
                k="Clearinghouse fee"
                v={usdgOrDash(amounts?.fee)}
                dense
              />
              <Row
                k="You receive"
                v={
                  amounts === undefined ? (
                    "—"
                  ) : (
                    <>
                      {fmtNvdaExact(amounts.nvdaOut)} <Unit>{MARKET}</Unit>
                    </>
                  )
                }
                dense
              />
              <Row k="USDG approved to the clearinghouse" className={STACK_360} v={usdgOrDash(pos.usdgAllowance)} dense />
              <Row k="Your USDG" v={usdgOrDash(pos.usdgBalance)} dense />
            </Rows>
          </div>

          {amount !== undefined && balance !== undefined && amount > balance ? (
            <Notice tone="danger" className="mt-4" role="status">
              This wallet holds {balance.toString()} contract{balance === 1n ? "" : "s"} of this option; enter that many
              or fewer.
            </Notice>
          ) : null}

          {needsConfirmation ? (
            <SpotWarning check={check} spot={spot} strike={pos.strikeUsdg} amounts={checkAmounts} />
          ) : null}

          {windowState === "open" ? (
            <div id="exercise-status" aria-live="polite">
              {button.blocker === "usdgShort" && amounts !== undefined ? (
                <Notice tone="danger" className="mt-4" title={<>Not enough USDG for this exercise.</>}>
                  The clearinghouse pulls {fmtUsdgExact(amounts.total)} USDG and this wallet holds{" "}
                  {fmtUsdgExact(pos.usdgBalance)} USDG.
                </Notice>
              ) : (
                <SimulationNotice verdict={verdict} pending={simulable && verdict === undefined} total={amounts?.total} />
              )}
            </div>
          ) : null}

          {windowState === "open" && needsConfirmation ? (
            <label
              htmlFor="exercise-confirm"
              data-slot="exercise-confirm"
              className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13.5px] leading-[1.5] text-ink-2"
            >
              <input
                id="exercise-confirm"
                type="checkbox"
                className="mt-[3px] size-4 shrink-0 accent-accent"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmedFor(e.target.checked ? confirmKey : null)}
              />
              <span>I understand this exercise may cost more than the {MARKET} is worth, and I want to exercise anyway.</span>
            </label>
          ) : null}

          <div className="mt-5">
            <Button
              id="exercise-submit"
              className="w-full"
              disabled={!button.enabled}
              aria-describedby="exercise-hint"
              onClick={exercise}
            >
              {button.label}
            </Button>
          </div>

          <p id="exercise-hint" data-slot="exercise-hint" className="mt-3 text-[12.5px] leading-[1.55] text-ink-3">
            {hintFor(button.blocker, windowState)} Exercising calls <code>exercise(optionId, amount)</code> on the clearinghouse
            {clear !== undefined ? (
              <>
                {" "}
                at{" "}
                <ExternalLink href={addressUrl(clear)} className="link num">
                  {shortAddress(clear)}
                </ExternalLink>
              </>
            ) : null}
            . It takes the USDG above from this wallet and sends the {MARKET} Stock Token in the same transaction. When the
            wallet&apos;s USDG approval to the clearinghouse is below that total, the button first asks for an approval
            of exactly the total, never more. Stonkhouse takes no fee on exercise.
          </p>
        </>
      )}
    </Card>
  );
}

/** What a spot confirmation was given for: the verdict and the amount. */
function confirmationKey(check: SpotCheck, amount: bigint | undefined): string {
  return `${check}:${amount === undefined ? "" : amount.toString()}`;
}

/** Ledger rows that go under their label when the card is narrow. */
const STACK_540 =
  "@max-[540px]:flex-col @max-[540px]:items-start! @max-[540px]:gap-y-1 @max-[540px]:[&>dd]:ml-0 @max-[540px]:[&>dd]:text-left";
const STACK_360 =
  "@max-[360px]:flex-col @max-[360px]:items-start! @max-[360px]:gap-y-1 @max-[360px]:[&>dd]:ml-0 @max-[360px]:[&>dd]:text-left";

function usdgOrDash(value: bigint | undefined) {
  return value === undefined ? (
    "—"
  ) : (
    <>
      {fmtUsdgExact(value)} <Unit>USDG</Unit>
    </>
  );
}

/** The sentence under the button, naming what it waits for. Empty once it is live. */
function hintFor(blocker: ExerciseBlocker | undefined, windowState: ExerciseWindow): string {
  switch (blocker) {
    case undefined:
    case "busy":
      return "";
    case "window":
      return windowState === "before" ? "The button turns on at the exercise time, by the chain's clock." : "";
    case "assets":
      return "This option cannot be exercised from here.";
    case "reading":
      return "Reading the clearinghouse…";
    case "noAmount":
      return "Enter a whole number of contracts, at least 1.";
    case "overBalance":
      return "Enter no more contracts than this wallet holds.";
    case "usdgShort":
      return "Add USDG to this wallet to cover the total.";
    case "simulating":
      return "Simulating this exercise against the chain; the button turns on once the simulation allows it.";
    case "refused":
      return "The button stays off while the simulation says this exercise would fail; it re-simulates every few seconds.";
    case "confirm":
      return "Tick the box above to exercise anyway.";
    case "notConnected":
      return "Connect a wallet.";
    case "wrongNetwork":
      return "Switch the wallet to Robinhood Chain.";
  }
}

/** What a verdict says, as one sentence for a toast. */
function verdictSentence(verdict: ExerciseVerdict | undefined, total: bigint, usdgBalance: bigint | undefined): string {
  if (verdict === undefined) return "The simulation did not return a verdict. Nothing was sent; try again.";
  switch (verdict.kind) {
    case "ok":
      return "The simulation passed.";
    case "needsApproval":
      return "The USDG approval to the clearinghouse still does not cover this exercise. Nothing more was sent; try again.";
    case "usdgShort":
      return `The clearinghouse pulls ${fmtUsdgExact(total)} USDG and this wallet holds ${fmtUsdgExact(usdgBalance)} USDG.`;
    case "clearRefused":
    case "tokenRefused":
      return verdict.decoded.text;
    case "inconclusive":
      return verdict.text;
  }
}

/** The spot warning: spot at or below the strike, or unreadable. */
function SpotWarning({
  check,
  spot,
  strike,
  amounts,
}: {
  check: "notWorth" | "unknown" | "worth";
  spot: bigint | undefined;
  strike: bigint | undefined;
  amounts: ExerciseAmounts | undefined;
}) {
  if (check === "unknown") {
    return (
      <Notice tone="warn" className="mt-4" title={<>Spot could not be read, so this page cannot tell whether exercising is worth it.</>}>
        The vault&apos;s price feed did not answer, or is stale. If spot is at or below the strike, exercising costs more
        than the {MARKET} you receive is worth. Check the {MARKET} price yourself before you exercise.
      </Notice>
    );
  }
  const withFee = amounts !== undefined && amounts.fee > 0n;
  return (
    <Notice
      tone="warn"
      className="mt-4"
      title={
        withFee ? (
          <>With the clearinghouse&apos;s fee, exercising now costs more than the {MARKET} is worth at spot.</>
        ) : (
          <>Spot is at or below the strike: exercising now costs more than the {MARKET} is worth.</>
        )
      }
    >
      The vault&apos;s feed reads {fmtUsdgExact(spot)} USDG for one {MARKET}, and the strike is {fmtUsdgExact(strike)} USDG
      per contract{withFee ? <>, plus the clearinghouse&apos;s fee</> : null}. At that spot, buying {MARKET} directly
      costs no more than exercising.
    </Notice>
  );
}

/** What the simulation said, in the tone it deserves. */
function SimulationNotice({ verdict, pending, total }: { verdict: ExerciseVerdict | undefined; pending: boolean; total: bigint | undefined }) {
  if (verdict === undefined) {
    return pending ? (
      <p className="mt-4 text-[12.5px] leading-[1.55] text-ink-3">Simulating this exercise against the chain…</p>
    ) : null;
  }
  switch (verdict.kind) {
    case "ok":
      return (
        <Notice tone="info" className="mt-4" title={<>Simulation passed.</>}>
          The clearinghouse accepts this exercise now: it takes the USDG and sends the {MARKET}.
        </Notice>
      );
    case "needsApproval":
      return (
        <Notice tone="info" className="mt-4" title={<>The clearinghouse&apos;s checks pass.</>}>
          Only the USDG approval is missing. The button first approves exactly {fmtUsdgExact(total)} USDG to the
          clearinghouse, simulates again, then exercises.
        </Notice>
      );
    case "usdgShort":
      return (
        <Notice tone="danger" className="mt-4" title={<>Not enough USDG for this exercise.</>}>
          {verdict.decoded?.text ?? "The wallet's USDG balance does not cover the total."}
        </Notice>
      );
    case "clearRefused":
      return (
        <Notice
          tone="danger"
          className="mt-4"
          title={<>The clearinghouse would refuse this exercise{verdict.decoded.name ? ` (${verdict.decoded.name})` : ""}.</>}
        >
          {verdict.decoded.text}
        </Notice>
      );
    case "tokenRefused":
      return (
        <Notice tone="danger" className="mt-4" title={<>A token would not move for this exercise.</>}>
          {verdict.decoded.text}
        </Notice>
      );
    case "inconclusive":
      return (
        <Notice tone="warn" className="mt-4" title={<>The simulation could not say whether this exercise goes through.</>}>
          {verdict.text} The button is left on; your wallet shows the real outcome before you sign.
        </Notice>
      );
  }
}
