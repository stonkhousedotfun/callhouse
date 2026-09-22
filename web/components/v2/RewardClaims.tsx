"use client";

/**
 * The epoch-reward claim UI, for any {RewardProgram}.
 *
 * EXTRACTED FROM `MakersPage.tsx` BY T-133, UNCHANGED IN BEHAVIOUR. Every string the maker path used
 * to render is reproduced here exactly; the only difference is where the token's name and decimals
 * come from. With `makerProgram(...)` passed in they are the maker program's, and `id` is "maker", so
 * the labels, the amounts, the notices, the button text and even the React Query keys are identical
 * to what shipped before. That is criterion 4, and it is why the symbol is interpolated rather than
 * the component being forked per program.
 *
 * NO TOKEN NAME AND NO DECIMALS LITERAL APPEARS IN THIS FILE, deliberately, so that grepping it for
 * either returns nothing. A hardcoded decimals argument here is the exact bug this extraction removes:
 * formatting an 18-decimal amount with the 6-decimal scale does not throw, it renders a figure about
 * a trillion times too large beside a button that spends it.
 *
 * SINCE D6 THE SCALE IS A CHAIN READ, SO IT CAN ALSO BE ABSENT. `program.token` is null until
 * `decimals()` and `symbol()` return, and null again if either fails. This component renders that
 * state explicitly and offers NO claim action in it: it cannot say what the button would spend, so
 * it does not show the button. There is no numeric fallback anywhere in this file — that is what
 * makes "no number" an improvement on "wrong number" rather than a different way to be wrong.
 *
 * NO RATE, EVER. This component shows one epoch's published amount and nothing derived from it — no
 * per-week figure, no average across epochs, no projection. the forbidden-copy rules banned (copy-lint removed 2026-09-21, so nothing bans them now) the
 * vocabulary; what it cannot ban is arithmetic, so there is none here.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { Address, WalletClient } from "viem";
import { useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, Panel } from "@/components/ui";
import { REWARD_AMOUNT_UNAVAILABLE, resolveRewardToken, rewardAmountText, rewardProgramConfigured,
  rewardTokenQueryKey, withRewardToken, type RewardProgram } from "@/lib/v2/rewardPrograms";
import { claimReward, parseRewardEpochFile, readRewardClaim } from "@/lib/v2/rewardClaim";

/**
 * Resolve the program's reward token here, so NO caller has to.
 *
 * Both pages pass a program built from an address alone; the decimals and symbol are a chain read
 * and this is the one component both of them render. Doing it here is what keeps the maker page
 * working unchanged after D6 deleted its `6` and its "USDG" — the caller still writes
 * `makerProgram(distributor)` and the scale arrives from the token itself.
 *
 * A program that already carries a token is passed through untouched, so a caller that has its own
 * resolved token (the lender page needs one for its epoch-pool line) does not trigger a second
 * read; the shared query key means even then it is one fetch, not two.
 */
function useResolvedProgram(program: RewardProgram): RewardProgram {
  const distributor = program.distributor;
  const token = useQuery({
    queryKey: rewardTokenQueryKey(program),
    enabled: program.token === null && distributor !== null,
    queryFn: () => resolveRewardToken(distributor!),
    staleTime: 300_000, retry: 0,
  });
  if (program.token !== null) return program;
  return token.data ? withRewardToken(program, token.data) : program;
}

export function ClaimForEpoch({ program, epoch, account, distributor }: {
  program: RewardProgram; epoch: number; account: Address; distributor: Address;
}) {
  const wallet = useWalletClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const file = useQuery({ queryKey: [`${program.id}-epoch-file`, epoch], queryFn: async () => {
    const response = await fetch(`${program.epochBasePath}/${epoch}.json`, { cache: "no-store" });
    if (response.status === 404) return null; // operator has not published a root for this epoch
    if (!response.ok) throw new Error("Reward file could not be loaded.");
    return parseRewardEpochFile(await response.json(), epoch);
  }, staleTime: 60_000, refetchInterval: 60_000, retry: 0 });
  const claim = useQuery({ queryKey: [`${program.id}-claim`, epoch, account, file.data?.root, distributor],
    enabled: Boolean(file.data), queryFn: () => readRewardClaim(distributor, file.data!, account),
    staleTime: 15_000, retry: 0 });
  if (file.isPending) return <p className="text-sm text-ink-2">Epoch {epoch}: checking published rewards…</p>;
  if (file.isError) return <Notice tone="warn" role="status">Epoch {epoch}: {file.error.message}
    <Button size="xs" variant="ghost" className="ml-2" disabled={file.isFetching}
      onClick={() => void file.refetch()}>{file.isFetching ? "Retrying…" : "Try again"}</Button>
  </Notice>;
  if (!file.data) return <p className="text-sm text-ink-2">Epoch {epoch}: no reward file published yet.</p>;
  if (claim.isPending) return <p className="text-sm text-ink-2">Epoch {epoch}: checking the chain…</p>;
  if (claim.isError) return <Notice tone="warn" role="status">Epoch {epoch}: {claim.error.message}
    <Button size="xs" variant="ghost" className="ml-2" disabled={claim.isFetching}
      onClick={() => void claim.refetch()}>{claim.isFetching ? "Retrying…" : "Try again"}</Button>
  </Notice>;
  const reward = claim.data;
  if (!reward || reward.status === "no-reward") return <p className="text-sm text-ink-2">Epoch {epoch}: no reward for this wallet.</p>;
  const token = program.token;
  if (!token) return <p className="text-sm text-ink-2">Epoch {epoch}: {REWARD_AMOUNT_UNAVAILABLE} — the reward token could not be read.</p>;
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-0">
    <p className="text-sm"><span className="font-semibold">Epoch {epoch}</span> · {rewardAmountText(BigInt(reward.entry!.amount), program)}
      {reward.status === "claimed" ? <span className="ml-2 text-ink-2">Claimed</span> : null}</p>
    {reward.status === "ready" ? <Button size="sm" disabled={pending || !wallet.data} onClick={async () => {
      if (!wallet.data || !file.data || !reward.entry) return;
      setPending(true);
      try {
        notice("pending", `Confirm ${program.label} reward`, `Review the ${token.symbol} claim in your wallet.`);
        await claimReward(wallet.data as WalletClient, account, distributor, file.data, reward.entry);
        await client.invalidateQueries({ queryKey: [`${program.id}-claim`, epoch, account] });
        notice("success", "Reward claimed", `${token.symbol} was sent to your wallet.`);
      } catch (error) {
        if (!unknownReceipt(error))
          notice("error", "Claim stopped", error instanceof Error ? error.message : "The claim could not be completed.");
      } finally { setPending(false); }
    }}>{pending ? "Claiming…" : `Claim ${token.symbol}`}</Button> : null}
  </div>;
}

/**
 * The claims panel. `epochs` is supplied by the caller because each program knows its own epoch
 * history: the maker page derives it from `useMaker(address)`, and the lender page has no equivalent
 * route yet (see `notice`).
 */
export function RewardClaims({ program, address, epochs, heading, lede, notice: leadNotice, unavailable }: {
  program: RewardProgram;
  address: Address | undefined;
  epochs: number[];
  heading: string;
  lede: string;
  notice?: ReactNode;
  /** Rendered above the list when the caller knows older epochs could not be loaded. */
  unavailable?: ReactNode;
}) {
  const resolved = useResolvedProgram(program);
  return <Panel as="section" id={`${resolved.id}-rewards`} className="mt-6">
    <h2 className="font-display text-xl font-bold">{heading}</h2>
    <p className="mt-2 text-sm text-ink-2">{lede}</p>
    {leadNotice}
    {!address ? <div className="mt-4"><ConnectButton /></div> : !rewardProgramConfigured(resolved)
      ? <Notice tone="info" className="mt-4">{resolved.notConfiguredNotice}</Notice>
      : <div className="mt-4 space-y-2">{unavailable}
        {epochs.map((id) => <ClaimForEpoch key={`${address}-${id}`} program={resolved} epoch={id}
          account={address} distributor={resolved.distributor!} />)}</div>}
  </Panel>;
}
