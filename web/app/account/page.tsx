"use client";

import { useMemo, useState } from "react";
import { formatUnits, type Abi, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useTxRunner } from "@/components/TxToast";
import { Button, Card, Chip, Field } from "@/components/ui";
import {
  ASSET,
  ASSET_DECIMALS,
  FACTORY,
  MARKET,
  USDG,
  ZERO_ADDRESS,
  accountFactoryAbi,
  stockTokenAbi,
  writerAccountAbi,
} from "@/lib/contracts";
import { fmtAsset, fmtUsdg, parseAmount } from "@/lib/format";
import { useMounted } from "@/lib/hooks";

export default function AccountPage() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [depositRaw, setDepositRaw] = useState("");
  const [offerRaw, setOfferRaw] = useState("");
  const [busy, setBusy] = useState(false);

  const accountRead = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "accountOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const account = (typeof accountRead.data === "string" ? accountRead.data : undefined) as Address | undefined;
  const hasAccount = Boolean(account && account !== ZERO_ADDRESS);

  const walletNvda = useReadContract({
    address: ASSET,
    abi: stockTokenAbi as unknown as Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const idle = useReadContract({
    address: account,
    abi: writerAccountAbi as unknown as Abi,
    functionName: "idleAssets",
    query: { enabled: hasAccount },
  });
  const reserved = useReadContract({
    address: account,
    abi: writerAccountAbi as unknown as Abi,
    functionName: "reserved",
    query: { enabled: hasAccount },
  });
  const requested = useReadContract({
    address: account,
    abi: writerAccountAbi as unknown as Abi,
    functionName: "requestedLots",
    query: { enabled: hasAccount },
  });
  const listed = useReadContract({
    address: account,
    abi: writerAccountAbi as unknown as Abi,
    functionName: "listedLots",
    query: { enabled: hasAccount },
  });
  const written = useReadContract({
    address: account,
    abi: writerAccountAbi as unknown as Abi,
    functionName: "contractsWritten",
    query: { enabled: hasAccount },
  });
  const usdgBal = useReadContract({
    address: USDG,
    abi: stockTokenAbi as unknown as Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: hasAccount },
  });
  const allowance = useReadContract({
    address: ASSET,
    abi: stockTokenAbi as unknown as Abi,
    functionName: "allowance",
    args: address && account ? [address, account] : undefined,
    query: { enabled: hasAccount && Boolean(address) },
  });
  const week = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "week",
  });

  const weekId =
    week.data && typeof week.data === "object" && "id" in (week.data as object)
      ? Number((week.data as { id: number }).id)
      : Array.isArray(week.data)
        ? Number(week.data[0])
        : 0;
  const idleAmt = typeof idle.data === "bigint" ? idle.data : 0n;
  const reservedAmt = typeof reserved.data === "bigint" ? reserved.data : 0n;
  const usdgAmt = typeof usdgBal.data === "bigint" ? usdgBal.data : 0n;
  const listedAmt = typeof listed.data === "bigint" ? listed.data : 0n;
  const writtenAmt = typeof written.data === "bigint" ? written.data : 0n;
  const requestedAmt = typeof requested.data === "bigint" ? requested.data : 0n;
  const walletAmt = typeof walletNvda.data === "bigint" ? walletNvda.data : 0n;
  const inAccount = idleAmt + reservedAmt;
  const wholeIdle = idleAmt / 10n ** BigInt(ASSET_DECIMALS);

  const refresh = () => {
    void accountRead.refetch();
    void walletNvda.refetch();
    void idle.refetch();
    void reserved.refetch();
    void requested.refetch();
    void listed.refetch();
    void written.refetch();
    void usdgBal.refetch();
    void allowance.refetch();
  };

  const depositAmt = useMemo(() => parseAmount(depositRaw, ASSET_DECIMALS), [depositRaw]);
  const offerLots = Number.parseInt(offerRaw || String(wholeIdle), 10);

  async function send(fn: () => Promise<`0x${string}`>, pending: string, success: string) {
    setBusy(true);
    try {
      const hash = await run(fn, { pending, success });
      refresh();
      return hash !== null;
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) {
    return <p className="py-8 text-sm text-ink-3">Loading…</p>;
  }

  if (!isConnected) {
    return (
      <div className="max-w-sm py-8">
        <h1 className="text-lg font-bold tracking-[-0.02em]">Account</h1>
        <p className="mt-1 mb-4 text-sm text-ink-2">Connect to deposit {MARKET}.</p>
        <ConnectButton />
      </div>
    );
  }

  if (!hasAccount) {
    return (
      <div className="max-w-sm py-8">
        <h1 className="text-lg font-bold tracking-[-0.02em]">Account</h1>
        <p className="mt-1 mb-4 text-sm text-ink-2">One transaction. Holds your {MARKET}.</p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            send(
              () =>
                writeContractAsync({
                  address: FACTORY,
                  abi: accountFactoryAbi as unknown as Abi,
                  functionName: "createAccount",
                }),
              "Open account",
              "Account opened",
            )
          }
        >
          Open account
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-bold tracking-[-0.02em]">Account</h1>
        <div className="flex flex-wrap gap-1.5">
          {listedAmt > 0n ? (
            <Chip tone="accent" dot>
              {listedAmt.toString()} listed
            </Chip>
          ) : (
            <Chip>Not listed</Chip>
          )}
          {writtenAmt > 0n ? <Chip tone="usdg">{writtenAmt.toString()} sold</Chip> : null}
          {weekId === 0 ? <Chip tone="warn">Week closed</Chip> : null}
        </div>
      </div>

      <dl className="mb-4 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line text-[12px]">
        <div className="bg-surface px-3 py-2.5">
          <dt className="text-ink-3">Account</dt>
          <dd className="num mt-0.5 font-semibold">
            {fmtAsset(inAccount)} <span className="font-medium text-ink-3">{MARKET}</span>
          </dd>
        </div>
        <div className="bg-surface px-3 py-2.5">
          <dt className="text-ink-3">Free</dt>
          <dd className="num mt-0.5 font-semibold">
            {fmtAsset(idleAmt)} <span className="font-medium text-ink-3">{MARKET}</span>
          </dd>
        </div>
        <div className="bg-surface px-3 py-2.5">
          <dt className="text-ink-3">USDG</dt>
          <dd className="num mt-0.5 font-semibold text-usdg">{fmtUsdg(usdgAmt)}</dd>
        </div>
      </dl>

      <Card pad="sm" className="grid gap-4">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px]">
            <span className="font-semibold text-ink-2">Deposit</span>
            <button
              type="button"
              className="link"
              onClick={() => setDepositRaw(formatUnits(walletAmt, ASSET_DECIMALS))}
            >
              Wallet {fmtAsset(walletAmt)}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Field
              id="solo-deposit"
              size="sm"
              className="min-w-0 flex-1"
              suffix={MARKET}
              value={depositRaw}
              onChange={(e) => setDepositRaw(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
            <Button
              size="sm"
              disabled={busy || depositAmt === null || depositAmt === 0n}
              onClick={async () => {
                const amt = depositAmt!;
                const current = (allowance.data as bigint | undefined) ?? 0n;
                if (current < amt) {
                  const ok = await send(
                    () =>
                      writeContractAsync({
                        address: ASSET,
                        abi: stockTokenAbi as unknown as Abi,
                        functionName: "approve",
                        args: [account, amt],
                      }),
                    "Approve",
                    "Approved",
                  );
                  if (!ok) return;
                }
                await send(
                  () =>
                    writeContractAsync({
                      address: account!,
                      abi: writerAccountAbi as unknown as Abi,
                      functionName: "deposit",
                      args: [amt],
                    }),
                  "Deposit",
                  "Deposited",
                );
                setDepositRaw("");
              }}
            >
              Deposit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || idleAmt === 0n}
              onClick={() =>
                send(
                  () =>
                    writeContractAsync({
                      address: account!,
                      abi: writerAccountAbi as unknown as Abi,
                      functionName: "withdraw",
                      args: [idleAmt],
                    }),
                  "Withdraw",
                  "Withdrawn",
                )
              }
            >
              Withdraw
            </Button>
          </div>
        </div>

        <div className="border-t border-line pt-4">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px]">
            <span className="font-semibold text-ink-2">Offer this week</span>
            {wholeIdle > 0n && listedAmt === 0n ? (
              <button type="button" className="link" onClick={() => setOfferRaw(wholeIdle.toString())}>
                Free {wholeIdle.toString()}
              </button>
            ) : null}
          </div>
          {weekId === 0 ? (
            <p className="text-[13px] text-ink-3">Week not open.</p>
          ) : listedAmt > 0n ? (
            <p className="text-[13px] text-ink-2">
              {listedAmt.toString()} {MARKET} listed
              {writtenAmt > 0n ? ` · ${writtenAmt.toString()} sold` : ""}.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Field
                id="solo-offer"
                size="sm"
                className="w-28 shrink-0"
                suffix={MARKET}
                value={offerRaw}
                placeholder={wholeIdle > 0n ? wholeIdle.toString() : "0"}
                onChange={(e) => setOfferRaw(e.target.value)}
                inputMode="numeric"
              />
              <Button
                size="sm"
                disabled={busy || !Number.isInteger(offerLots) || offerLots <= 0}
                onClick={async () => {
                  const lots = BigInt(offerLots);
                  if (requestedAmt !== lots) {
                    const ok = await send(
                      () =>
                        writeContractAsync({
                          address: account!,
                          abi: writerAccountAbi as unknown as Abi,
                          functionName: "requestWrite",
                          args: [lots],
                        }),
                      "Set amount",
                      "Amount set",
                    );
                    if (!ok) return;
                  }
                  await send(
                    () =>
                      writeContractAsync({
                        address: account!,
                        abi: writerAccountAbi as unknown as Abi,
                        functionName: "list",
                      }),
                    "List",
                    "Listed",
                  );
                }}
              >
                Offer
              </Button>
            </div>
          )}
        </div>
      </Card>

      {listedAmt > 0n || writtenAmt > 0n || usdgAmt > 0n ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {listedAmt > 0n || writtenAmt > 0n ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                send(
                  () =>
                    writeContractAsync({
                      address: account!,
                      abi: writerAccountAbi as unknown as Abi,
                      functionName: "settle",
                    }),
                  "Close the week",
                  "Week closed",
                )
              }
            >
              Close week
            </Button>
          ) : null}
          {usdgAmt > 0n ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                send(
                  () =>
                    writeContractAsync({
                      address: account!,
                      abi: writerAccountAbi as unknown as Abi,
                      functionName: "claimUsdg",
                    }),
                  "Collect USDG",
                  "Collected",
                )
              }
            >
              Collect {fmtUsdg(usdgAmt)} USDG
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
