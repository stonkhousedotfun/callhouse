"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatUnits, type Abi, type Address } from "viem";
import { useAccount, useBlock, useReadContract, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useTxRunner } from "@/components/TxToast";
import { Button, Card, Chip, Field } from "@/components/ui";
import { CHAIN_ID } from "@/lib/chain";
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
import { parseFactoryWeek } from "@/lib/factoryWeek";
import { fmtAsset, fmtUsdg, parseAmount } from "@/lib/format";
import { useMounted } from "@/lib/hooks";

function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100dvh-16rem)] items-center justify-center">
      <Card pad="sm" className="w-full max-w-sm text-center">
        <h1 className="text-base font-bold tracking-[-0.02em]">{title}</h1>
        {children}
      </Card>
    </div>
  );
}

export default function AccountPage() {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [depositRaw, setDepositRaw] = useState("");
  const [offerRaw, setOfferRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: block } = useBlock({
    chainId: CHAIN_ID,
    query: { refetchInterval: 15_000 },
  });
  const now = block?.timestamp;

  const accountRead = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "accountOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const account = (typeof accountRead.data === "string" ? accountRead.data : undefined) as Address | undefined;
  const hasAccount = Boolean(account && account !== ZERO_ADDRESS);
  const accountLoading = Boolean(address) && (accountRead.isLoading || accountRead.isFetching) && !accountRead.data;

  const walletNvda = useReadContract({
    address: ASSET,
    abi: stockTokenAbi as unknown as Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const walletUsdg = useReadContract({
    address: USDG,
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
  const accountUsdg = useReadContract({
    address: USDG,
    abi: stockTokenAbi as unknown as Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: hasAccount },
  });
  const listedExpiry = useReadContract({
    address: account,
    abi: writerAccountAbi as unknown as Abi,
    functionName: "listedExpiryTs",
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
  const halted = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "writesHalted",
  });

  const parsedWeek = parseFactoryWeek(week.data);
  const weekReady = week.isSuccess || week.isError;
  const weekOpen = Boolean(parsedWeek && parsedWeek.id > 0);
  const writesHalted = halted.data === true;
  const idleAmt = typeof idle.data === "bigint" ? idle.data : 0n;
  const reservedAmt = typeof reserved.data === "bigint" ? reserved.data : 0n;
  const walletUsdgAmt = typeof walletUsdg.data === "bigint" ? walletUsdg.data : 0n;
  const accountUsdgAmt = typeof accountUsdg.data === "bigint" ? accountUsdg.data : 0n;
  const listedAmt = typeof listed.data === "bigint" ? listed.data : 0n;
  const writtenAmt = typeof written.data === "bigint" ? written.data : 0n;
  const requestedAmt = typeof requested.data === "bigint" ? requested.data : 0n;
  const walletAmt = typeof walletNvda.data === "bigint" ? walletNvda.data : 0n;
  const listedExpiryTs =
    typeof listedExpiry.data === "bigint"
      ? listedExpiry.data
      : typeof listedExpiry.data === "number"
        ? BigInt(listedExpiry.data)
        : 0n;
  const inAccount = idleAmt + reservedAmt;
  const wholeIdle = idleAmt / 10n ** BigInt(ASSET_DECIMALS);
  const canSettle = listedExpiryTs > 0n && now !== undefined && now >= listedExpiryTs;

  const refresh = () =>
    Promise.all([
      accountRead.refetch(),
      walletNvda.refetch(),
      walletUsdg.refetch(),
      idle.refetch(),
      reserved.refetch(),
      requested.refetch(),
      listed.refetch(),
      written.refetch(),
      accountUsdg.refetch(),
      listedExpiry.refetch(),
      allowance.refetch(),
      week.refetch(),
      halted.refetch(),
    ]);

  const depositAmt = useMemo(() => parseAmount(depositRaw, ASSET_DECIMALS), [depositRaw]);
  const parsedOffer = Number.parseInt(offerRaw || String(wholeIdle), 10);
  const offerLots = Number.isInteger(parsedOffer) ? parsedOffer : NaN;
  const offerOk = Number.isInteger(offerLots) && offerLots > 0 && BigInt(offerLots) <= wholeIdle;

  async function send(fn: () => Promise<`0x${string}`>, pending: string, success: string) {
    setBusy(true);
    try {
      const hash = await run(fn, { pending, success });
      await refresh();
      return hash !== null;
    } finally {
      setBusy(false);
    }
  }

  const write = (args: Parameters<typeof writeContractAsync>[0]) =>
    writeContractAsync({ ...args, chainId: CHAIN_ID });

  if (!mounted) {
    return <div className="min-h-[calc(100dvh-16rem)]" />;
  }

  if (!isConnected) {
    return (
      <EmptyCard title="Account">
        <p className="mt-1 mb-4 text-[13px] text-ink-2">Connect to deposit {MARKET}.</p>
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      </EmptyCard>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <EmptyCard title="Account">
        <p className="mt-1 mb-4 text-[13px] text-ink-2">Switch to Robinhood Chain.</p>
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      </EmptyCard>
    );
  }

  if (accountLoading) {
    return <div className="min-h-[calc(100dvh-16rem)]" />;
  }

  if (accountRead.isError) {
    return (
      <EmptyCard title="Account">
        <p className="mt-1 mb-4 text-[13px] text-ink-2">Could not read this wallet&apos;s account.</p>
        <Button size="sm" onClick={() => void accountRead.refetch()}>
          Retry
        </Button>
      </EmptyCard>
    );
  }

  if (!hasAccount) {
    return (
      <EmptyCard title="Open an account">
        <p className="mt-1 mb-4 text-[13px] text-ink-2">Holds your {MARKET}.</p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            send(
              () =>
                write({
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
      </EmptyCard>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-base font-bold tracking-[-0.02em]">Account</h1>
        <div className="flex flex-wrap justify-end gap-1">
          {listedAmt > 0n ? (
            <Chip tone="accent" dot>
              {listedAmt.toString()} listed
            </Chip>
          ) : (
            <Chip>Not listed</Chip>
          )}
          {writtenAmt > 0n ? <Chip tone="usdg">{writtenAmt.toString()} sold</Chip> : null}
          {weekReady && !weekOpen ? <Chip tone="warn">Week closed</Chip> : null}
          {writesHalted ? <Chip tone="warn">Paused</Chip> : null}
        </div>
      </div>

      <dl className="mb-3 grid grid-cols-3 overflow-hidden rounded-md border border-line text-[11px] leading-tight">
        <div className="border-r border-line px-2.5 py-2">
          <dt className="text-ink-3">Account</dt>
          <dd className="num mt-0.5 font-semibold">
            {fmtAsset(inAccount)} <span className="text-ink-3">{MARKET}</span>
          </dd>
        </div>
        <div className="border-r border-line px-2.5 py-2">
          <dt className="text-ink-3">Free</dt>
          <dd className="num mt-0.5 font-semibold">
            {fmtAsset(idleAmt)} <span className="text-ink-3">{MARKET}</span>
          </dd>
        </div>
        <div className="px-2.5 py-2">
          <dt className="text-ink-3">USDG</dt>
          <dd className="num mt-0.5 font-semibold text-usdg">{fmtUsdg(walletUsdgAmt)}</dd>
        </div>
      </dl>

      <Card pad="sm" className="grid gap-3">
        <div>
          <div className="mb-1 flex items-baseline justify-between text-[11px]">
            <span className="font-semibold text-ink-2">Deposit</span>
            <button
              type="button"
              className="link"
              onClick={() => setDepositRaw(formatUnits(walletAmt, ASSET_DECIMALS))}
            >
              Wallet {fmtAsset(walletAmt)}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
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
              size="xs"
              disabled={busy || depositAmt === null || depositAmt === 0n || depositAmt > walletAmt}
              onClick={async () => {
                const amt = depositAmt!;
                const current = (allowance.data as bigint | undefined) ?? 0n;
                if (current < amt) {
                  const ok = await send(
                    () =>
                      write({
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
                    write({
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
              size="xs"
              variant="ghost"
              disabled={busy || idleAmt === 0n}
              onClick={() =>
                send(
                  () =>
                    write({
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
              Out
            </Button>
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-1 flex items-baseline justify-between text-[11px]">
            <span className="font-semibold text-ink-2">Offer</span>
            {wholeIdle > 0n && listedAmt === 0n ? (
              <button type="button" className="link" onClick={() => setOfferRaw(wholeIdle.toString())}>
                Free {wholeIdle.toString()}
              </button>
            ) : null}
          </div>
          {parsedWeek && weekOpen ? (
            <p className="mb-1 text-[11px] text-ink-3">
              {fmtUsdg(parsedWeek.strikeUsdg)} strike · {fmtUsdg(parsedWeek.askUsdg, 3)} USDG
            </p>
          ) : null}
          {!weekReady ? (
            <p className="text-[12px] text-ink-3">Loading…</p>
          ) : !weekOpen ? (
            <p className="text-[12px] text-ink-3">Week not open.</p>
          ) : listedAmt > 0n ? (
            <p className="text-[12px] text-ink-2">
              {listedAmt.toString()} {MARKET} listed
              {writtenAmt > 0n ? ` · ${writtenAmt.toString()} sold` : ""}.
            </p>
          ) : writesHalted ? (
            <p className="text-[12px] text-ink-3">New sales are paused.</p>
          ) : (
            <div className="flex items-center gap-1.5">
              <Field
                id="solo-offer"
                size="sm"
                className="w-24 shrink-0"
                suffix={MARKET}
                value={offerRaw}
                placeholder={wholeIdle > 0n ? wholeIdle.toString() : "0"}
                onChange={(e) => setOfferRaw(e.target.value)}
                inputMode="numeric"
              />
              <Button
                size="xs"
                disabled={busy || !offerOk}
                onClick={async () => {
                  const lots = BigInt(offerLots);
                  if (requestedAmt !== lots) {
                    const ok = await send(
                      () =>
                        write({
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
                      write({
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

      {canSettle || accountUsdgAmt > 0n ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {canSettle ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                send(
                  () =>
                    write({
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
          {accountUsdgAmt > 0n ? (
            <Button
              size="xs"
              disabled={busy}
              onClick={() =>
                send(
                  () =>
                    write({
                      address: account!,
                      abi: writerAccountAbi as unknown as Abi,
                      functionName: "claimUsdg",
                    }),
                  "Collect USDG",
                  "Collected",
                )
              }
            >
              Collect {fmtUsdg(accountUsdgAmt)} USDG
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
