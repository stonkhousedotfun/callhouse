"use client";

/**
 * Lender rewards: Earn-vault suppliers are paid in $STONKHOUSE from the lender program's own
 * `RewardsDistributor` instance (P8-05).
 *
 * WHAT THIS PAGE SHOWS, AND THE ONE THING IT WILL NOT. It shows PUBLISHED-EPOCH FACTS: the pool for
 * an epoch (the epoch file's `total`, which the parser has already cross-checked against the sum of
 * every entry — `rewardClaim.ts` parse step) and this wallet's share of it. It shows NO rate, no
 * per-week figure, no average across epochs and no projection. the forbidden-copy rules banned (copy-lint removed 2026-09-21, so nothing bans them now) the
 * vocabulary, but nothing bans arithmetic, so there is none: every figure here is a number read out
 * of a signed, root-checked file.
 *
 * DEFERRED ON PURPOSE (task criterion 9): the mid-epoch, time-weighted RUNNING share. Credit is
 * "assets held multiplied by seconds held across the epoch window, not the closing balance"
 * (`ops/runbooks/lender-rewards-epoch.md`, Generate), which needs a per-account Earn-vault balance
 * SERIES over the window. That route does not exist — the runbook says so itself, and it is why the
 * generator's `--input` is a hand-made file rather than an indexer read. Showing a running share
 * without it would mean inventing one from a closing balance, which would be wrong for exactly the
 * wallets the time-weighting exists to treat fairly. Recorded in the ledger.
 *
 * NO EPOCH INDEX EXISTS EITHER, which is why the reader names the epoch. The maker page can list
 * epochs because `useMaker(address)` returns them; there is no lender equivalent. Rather than
 * guessing a range and rendering a column of "no reward file published yet", the page asks.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useAccount } from "wagmi";

import { Button, Notice, PageHead, Panel } from "@/components/ui";
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
  if (file.isPending) return <p className="mt-3 text-sm text-ink-2">Epoch {epoch}: checking published rewards…</p>;
  if (file.isError) return <Notice tone="warn" role="status" className="mt-3">Epoch {epoch}: {file.error.message}</Notice>;
  if (!file.data) return <p className="mt-3 text-sm text-ink-2">Epoch {epoch}: no reward file published yet.</p>;
  // A zero-amount entry is in the PINNED vector on purpose (index 3), and the contract's claim
  // transfers only `if (amount != 0)` while still marking the index claimed. So a wallet can be in a
  // published epoch and be owed nothing; that has to read as a fact, not as a failed lookup.
  const paid = file.data.entries.filter((entry) => BigInt(entry.amount) > 0n).length;
  return <p className="mt-3 text-sm text-ink-2">
    Epoch {epoch} pool: <span className="num font-semibold">{rewardAmountText(BigInt(file.data.total), program)}</span>,
    shared by {paid} of {file.data.entries.length} {file.data.entries.length === 1 ? "wallet" : "wallets"} in the file.
  </p>;
}

export function LenderRewardsPage() {
  const { address } = useAccount();
  const program = useLenderProgram();
  const [input, setInput] = useState("");
  const [epoch, setEpoch] = useState<number | null>(null);
  const parsed = /^\d{1,9}$/.test(input.trim()) ? Number(input.trim()) : null;

  return <>
    <PageHead eyebrow="Lending" title="Lender rewards."
      lede="Earn-vault suppliers are paid in STONKHOUSE for a bootstrap period, on top of whatever interest the venue pays." />

    <Notice tone="warn" className="mb-5">
      Supplied stock earns nothing until borrowers exist. These rewards are a fixed pool for a finished
      week, shared by time-weighted deposits — what you see below is what was published for that week,
      not what any future week will pay.
    </Notice>

    {/*
      Stated unconditionally, not only when the program is unconfigured: the contract verifies a
      Merkle proof and does not ask who is calling, so this page cannot grant or withhold a claim.
      Saying so matters because a page that looks like a gate invites people to believe it is one.
    */}
    <p className="mb-5 text-sm text-ink-2">
      Claiming is permissionless. The distributor checks your Merkle proof on chain, so this page is a
      convenience for finding your entry — it is never an eligibility gate, and it decides nothing.
    </p>

    {!rewardProgramConfigured(program)
      ? <Notice tone="info" className="mb-5">{program.notConfiguredNotice}</Notice>
      : null}

    <Panel as="section" aria-label="Choose an epoch">
      <h2 className="font-display text-xl font-bold">Look up a published week</h2>
      <p className="mt-2 text-sm text-ink-2">
        Enter the epoch number. There is no index of lender epochs yet, so the week has to be named.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor="lender-epoch" className="text-sm font-semibold">Epoch</label>
        <input id="lender-epoch" inputMode="numeric" value={input} onChange={(event) => setInput(event.target.value)}
          placeholder="2958" className="num min-h-11 w-32 rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        <Button size="sm" disabled={parsed === null} onClick={() => setEpoch(parsed)}>Look up</Button>
      </div>
      {input.trim() !== "" && parsed === null
        ? <p className="mt-3 text-sm text-ink-2">Enter a whole epoch number.</p> : null}
      {epoch !== null ? <EpochPool epoch={epoch} program={program} /> : null}
    </Panel>

    <RewardClaims program={program} address={address} epochs={epoch === null ? [] : [epoch]}
      heading="Claim epoch rewards"
      lede="The operator publishes a reward file after an epoch and posts its root on chain. The app checks your proof against that root before asking your wallet to claim."
      notice={epoch === null
        ? <p className="mt-2 text-sm text-ink-2">Look up a week above to see whether it holds a reward for this wallet.</p>
        : null} />
  </>;
}
