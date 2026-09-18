"use client";

import { useState } from "react";
import type { Abi } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { useNotice, useTxRunner } from "@/components/TxToast";
import { Button, Card, CardHead, CardTitle } from "@/components/ui";
import { CHAIN_ID } from "@/lib/chain";
import { CLEARINGHOUSE, USDG, stockTokenAbi, valoremClearAbi } from "@/lib/contracts";
import { approvalFor, exerciseAmounts, exerciseWindow } from "@/lib/exercise";
import { fmtUsdg } from "@/lib/format";

export type LegacyHeldCall = {
  optionId: bigint;
  balance: bigint;
  window: ReturnType<typeof exerciseWindow>;
};

function optionTuple(data: unknown) {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const exerciseAmount = row.exerciseAmount ?? row[3];
  const underlyingAmount = row.underlyingAmount ?? row[1];
  const exerciseTs = row.exerciseTimestamp ?? row[4];
  const expiryTs = row.expiryTimestamp ?? row[5];
  if (exerciseAmount === undefined || underlyingAmount === undefined || exerciseTs === undefined || expiryTs === undefined) return null;
  return { exerciseAmount: BigInt(exerciseAmount as bigint), underlyingAmount: BigInt(underlyingAmount as bigint),
    exerciseTs: Number(exerciseTs), expiryTs: Number(expiryTs) };
}

/** V1 buyer exercise remains available through the last Valorem option's exercise window. */
export function ExercisePanel({ rows, ticker, onDone }: { rows: readonly LegacyHeldCall[]; ticker: string; onDone: () => void }) {
  const { address, chainId } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const notice = useNotice();
  const [busy, setBusy] = useState(false);

  async function exercise(optionId: bigint, requested: bigint) {
    if (!address || !client || chainId !== CHAIN_ID || busy) return;
    setBusy(true);
    try {
      const raw = await client.readContract({ address: CLEARINGHOUSE, abi: valoremClearAbi as unknown as Abi,
        functionName: "option", args: [optionId] });
      const option = optionTuple(raw);
      if (!option) throw new Error("Could not read this v1 call from Valorem.");
      const now = Number((await client.getBlock()).timestamp);
      if (exerciseWindow(option, now) !== "open") throw new Error("This call is outside its exercise window.");
      const held = await client.readContract({ address: CLEARINGHOUSE, abi: valoremClearAbi as unknown as Abi,
        functionName: "balanceOf", args: [address, optionId] }) as bigint;
      if (requested <= 0n || held < requested) throw new Error("Your v1 call balance changed. Refresh this page.");
      const [feesEnabled, feeBps] = await Promise.all([
        client.readContract({ address: CLEARINGHOUSE, abi: valoremClearAbi as unknown as Abi, functionName: "feesEnabled" }),
        client.readContract({ address: CLEARINGHOUSE, abi: valoremClearAbi as unknown as Abi, functionName: "feeBps" }),
      ]);
      const amounts = exerciseAmounts({ amount: requested, strikeUsdg: option.exerciseAmount,
        underlyingAmount: option.underlyingAmount, feesEnabled: Boolean(feesEnabled), feeBps: Number(feeBps) });
      if (!amounts) throw new Error("Could not calculate the exact v1 exercise cost.");
      const [balance, allowance] = await Promise.all([
        client.readContract({ address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
        client.readContract({ address: USDG, abi: stockTokenAbi as unknown as Abi, functionName: "allowance", args: [address, CLEARINGHOUSE] }) as Promise<bigint>,
      ]);
      if (balance < amounts.total) throw new Error(`You need ${fmtUsdg(amounts.total)} USDG to exercise these calls.`);
      const approval = approvalFor(allowance, amounts.total);
      if (approval === undefined) throw new Error("Could not calculate the USDG approval.");
      if (approval > 0n) {
        const { request } = await client.simulateContract({ account: address, address: USDG,
          abi: stockTokenAbi as unknown as Abi, functionName: "approve", args: [CLEARINGHOUSE, approval] });
        const hash = await run(() => writeContractAsync({ ...request, chainId: CHAIN_ID }),
          { pending: "Approve v1 exercise cost", success: "USDG approved" });
        if (!hash) return;
      }
      const { request } = await client.simulateContract({ account: address, address: CLEARINGHOUSE,
        abi: valoremClearAbi as unknown as Abi, functionName: "exercise", args: [optionId, requested] });
      const hash = await run(() => writeContractAsync({ ...request, chainId: CHAIN_ID }),
        { pending: "Exercise v1 call", success: "V1 call exercised" });
      if (hash) onDone();
    } catch (error) {
      notice("error", "Exercise not sent", error instanceof Error ? error.message : "Could not verify this call.");
    } finally { setBusy(false); }
  }

  if (!rows.length) return null;
  return <section className="mb-6" aria-labelledby="legacy-exercise-h">
    <h2 id="legacy-exercise-h" className="mb-3 text-lg font-bold tracking-[-0.015em]">Yours to exercise</h2>
    <div className="grid gap-3">{rows.map((row) => {
      const label = row.window === "before" ? "Opens later" : row.window === "expired" ? "Expired" : "Exercise";
      return <Card key={row.optionId.toString()}><CardHead><CardTitle>{row.balance.toString()} {ticker} call</CardTitle></CardHead>
        <div className="mt-3"><Button disabled={busy || row.window !== "open" || !address || chainId !== CHAIN_ID}
          onClick={() => void exercise(row.optionId, row.balance)}>{label}</Button></div></Card>;
    })}</div>
  </section>;
}
