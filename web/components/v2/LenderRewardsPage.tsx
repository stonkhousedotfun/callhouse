"use client";

/**
 * Lender rewards: Earn-vault suppliers are paid in $STONKHOUSE from the lender program's own
 * `RewardsDistributor` instance.
 *
 * WHAT THIS PAGE SHOWS, AND THE ONE THING IT WILL NOT. It shows PUBLISHED-EPOCH FACTS: the pool for
 * an epoch (the epoch file's `total`, which the parser has already cross-checked against the sum of
 * every entry — `rewardClaim.ts` parse step) and this wallet's share of it. It shows NO rate, no
 * per-week figure, no average across epochs and no projection. The forbidden-copy rules banned (nothing bans them automatically now) the
 * vocabulary, but nothing bans arithmetic, so there is none: every figure here is a number read out
 * of a signed, root-checked file.
 *
 * DEFERRED ON PURPOSE (task criterion 9): the mid-epoch, time-weighted RUNNING share. Credit is
 * "assets held multiplied by seconds held across the epoch window, not the closing balance"
 * (the epoch runbook), which needs a per-account Earn-vault balance
 * SERIES over the window. That route does not exist — the runbook says so itself, and it is why the
 * generator's `--input` is a hand-made file rather than an indexer read. Showing a running share
 * without it would mean inventing one from a closing balance, which would be wrong for exactly the
 * wallets the time-weighting exists to treat fairly. A known gap.
 *
 * NO EPOCH INDEX EXISTS EITHER, which is why the reader names the epoch. The maker page can list
 * epochs because `useMaker(address)` returns them; there is no lender equivalent. Rather than
 * guessing a range and rendering a column of "no reward file published yet", the page asks.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useAccount } from "wagmi";

import { Button, FieldLabel, InfoTip, inputClasses, Notice, PageHead, Panel, Row, Rows } from "@/components/ui";
import { RewardClaims } from "@/components/v2/RewardClaims";
import { lenderDistributorAddress, lenderRewardProgram, parseLenderEpochFile } from "@/lib/v2/lenderRewards";
import { rewardAmountText, resolveRewardToken, rewardProgramConfigured, rewardTokenQueryKey,
  withRewardToken, type RewardProgram } from "@/lib/v2/rewardPrograms";

/**
 * The lender program as it currently resolves: its address from the validated build-time override,
 * its token from the distributor itself.
 *
 * The token read is a query rather than a constant because it is a chain call, and the honest
 * first render is "not known yet". While it is unresolved the program's status stays `planned`, so
 * every consumer below shows the unconfigured notice instead of an amount — that is the intended
 * behaviour, not a loading bug. Nothing here substitutes a decimals value when the read fails.
 */
function useLenderProgram(): RewardProgram {
  const program = lenderRewardProgram();
  const distributor = program.distributor;
  const token = useQuery({
    // The same key `RewardClaims` uses, so the panel below and this page's pool line share one read.
    queryKey: rewardTokenQueryKey(program),
    enabled: distributor !== null,
    queryFn: () => resolveRewardToken(distributor!),
    staleTime: 300_000, retry: 0,
  });
  return withRewardToken(program, token.data ?? null);
}

/** The pool for one published epoch. Read from the file, never computed here. */
function EpochPool({ epoch, program }: { epoch: number; program: RewardProgram }) {
  const file = useQuery({ queryKey: [`${program.id}-epoch-file`, epoch], queryFn: async () => {
    const response = await fetch(`${program.epochBasePath}/${epoch}.json`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Reward file could not be loaded.");
    return parseLenderEpochFile(await response.json(), epoch);
  }, staleTime: 60_000, retry: 0 });
  if (file.isPending) return <p role="status" className="text-sm text-ink-2">Week {epoch}: checking published rewards…</p>;
  if (file.isError) return <Notice tone="warn" role="status">Week {epoch}: {file.error.message}</Notice>;
  if (!file.data) return <p role="status" className="text-sm text-ink-2">Week {epoch}: no rewards published yet.</p>;
  // A zero-amount entry is in the PINNED vector on purpose (index 3), and the contract's claim
  // transfers only `if (amount != 0)` while still marking the index claimed. So a wallet can be in a
  // published epoch and be owed nothing; that has to read as a fact, not as a failed lookup.
  const paid = file.data.entries.filter((entry) => BigInt(entry.amount) > 0n).length;
  return <Rows className="rounded-md border border-line bg-field px-3.5">
    <Row k={`Week ${epoch} pool`} v={rewardAmountText(BigInt(file.data.total), program)} />
    <Row k="Shared by" mono={false}
      v={`${paid} of ${file.data.entries.length} ${file.data.entries.length === 1 ? "wallet" : "wallets"} in the file`} />
  </Rows>;
}

const LOOKUP_TIP = "Enter a week number to see the pool published for it. What you see is what was published for that week, not what a future week will pay.";
/**
 * Stated unconditionally, not only when the program is unconfigured: the contract verifies a Merkle proof and does not
 * ask who is calling, so this page cannot grant or withhold a claim. Saying so matters because a page that looks like a
 * gate invites people to believe it is one.
 */
const CLAIM_LEDE = "Anyone can claim. We check your proof against the on-chain root before your wallet claims.";
const CLAIM_TIP = "The reward contract checks your proof on chain. This page only helps you find your entry; it doesn't decide who can claim.";

export function LenderRewardsPage() {
  const { address } = useAccount();
  const program = useLenderProgram();
  const [input, setInput] = useState("");
  const [epoch, setEpoch] = useState<number | null>(null);
  const parsed = /^\d{1,9}$/.test(input.trim()) ? Number(input.trim()) : null;
  const invalid = input.trim() !== "" && parsed === null;

  return <>
    <PageHead eyebrow="Earn" title="Lender rewards."
      lede="STONKHOUSE for Earn lenders, paid per week once that week's rewards are published." />

    {!rewardProgramConfigured(program)
      ? <Notice tone="info" className="mb-6">{program.notConfiguredNotice}</Notice>
      : null}

    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Panel as="section" aria-label="Choose a week" className="grid gap-5">
        <h2 className="flex items-center gap-1.5 font-display text-xl font-bold">Look up a published week
          <InfoTip label="About published weeks" align="start" text={LOOKUP_TIP} /></h2>
        <form className="grid gap-1.5" onSubmit={(event) => { event.preventDefault(); if (parsed !== null) setEpoch(parsed); }}>
          <FieldLabel htmlFor="lender-epoch">Week</FieldLabel>
          <div className="flex items-stretch gap-3">
            <input id="lender-epoch" inputMode="numeric" placeholder="2958" autoComplete="off" aria-invalid={invalid || undefined}
              value={input} onChange={(event) => setInput(event.target.value)} className={`${inputClasses} flex-1 px-3.5 py-3 text-[17px]`} />
            <Button type="submit" className="shrink-0" disabled={parsed === null}>Look up</Button>
          </div>
        </form>
        {invalid ? <p role="status" className="-mt-2 text-[13px] font-medium text-danger-text">Enter a whole week number.</p> : null}
        {epoch !== null ? <EpochPool epoch={epoch} program={program} /> : null}
      </Panel>

      <div className="min-w-0 [&>section]:mt-0">
        <RewardClaims program={program} address={address} epochs={epoch === null ? [] : [epoch]}
          heading="Claim weekly rewards" lede={CLAIM_LEDE} tip={CLAIM_TIP}
          notice={epoch === null
            ? <p className="mt-2 text-sm text-ink-3">Look up a week first to see whether it holds a reward for this wallet.</p>
            : null} />
      </div>
    </div>
  </>;
}
