"use client";

import { useMemo, useState } from "react";
import { formatUnits, type Abi, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useTxRunner } from "@/components/TxToast";
import { Button, Card, Chip, Field, Notice, PageHead, Stat } from "@/components/ui";
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

  return (
    <>
      <PageHead
        eyebrow={MARKET}
        title={<>Your {MARKET}.</>}
        lede={<p>Put it in. Offer some this week. Keep the rest.</p>}
      />

      {!mounted ? (
        <Card className="max-w-lg">
          <p className="text-ink-2">Loading…</p>
        </Card>
      ) : !isConnected ? (
        <Card className="max-w-lg">
          <h2 className="text-[22px] font-bold tracking-[-0.02em]">Connect</h2>
          <p className="mt-2 mb-5 text-ink-2">MetaMask or Phantom. Robinhood Chain.</p>
          <ConnectButton block />
        </Card>
      ) : !hasAccount ? (
        <Card className="max-w-lg">
          <h2 className="text-[22px] font-bold tracking-[-0.02em]">Open an account</h2>
          <p className="mt-2 mb-5 text-ink-2">One transaction. Holds only your {MARKET}.</p>
          <Button
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
        </Card>
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {listedAmt > 0n ? (
              <Chip tone="accent" dot>
                {listedAmt.toString()} {MARKET} for sale
              </Chip>
            ) : (
              <Chip>Nothing listed</Chip>
            )}
            {writtenAmt > 0n ? <Chip tone="usdg">{writtenAmt.toString()} sold</Chip> : null}
            {weekId === 0 ? <Chip tone="warn">Week not open</Chip> : null}
          </div>

          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card>
              <Stat size="lg" label="In account" value={fmtAsset(inAccount)} unit={MARKET} />
            </Card>
            <Card>
              <Stat size="lg" label="Free" value={fmtAsset(idleAmt)} unit={MARKET} sub="can take out" />
            </Card>
            <Card>
              <Stat size="lg" label="USDG" value={fmtUsdg(usdgAmt)} tone="usdg" />
            </Card>
          </dl>

          <Card>
            <h2 className="text-[20px] font-bold tracking-[-0.02em]">Put {MARKET} in</h2>
            <p className="mt-1 mb-4 text-[14.5px] text-ink-2">
              Wallet: {fmtAsset(walletAmt)} {MARKET}
            </p>
            <Field
              id="solo-deposit"
              label="Amount"
              suffix={MARKET}
              value={depositRaw}
              onChange={(e) => setDepositRaw(e.target.value)}
              inputMode="decimal"
              hint={
                <button
                  type="button"
                  className="link text-[13px]"
                  onClick={() => setDepositRaw(formatUnits(walletAmt, ASSET_DECIMALS))}
                >
                  Use max
                </button>
              }
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
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
                Take out free
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="text-[20px] font-bold tracking-[-0.02em]">Offer this week</h2>
            <p className="mt-1 mb-4 text-[14.5px] text-ink-2">Whole {MARKET} only. The rest stays yours.</p>
            {weekId === 0 ? (
              <Notice tone="info">This week is not open yet.</Notice>
            ) : listedAmt > 0n ? (
              <p className="text-[15.5px] text-ink-2">
                {listedAmt.toString()} {MARKET} is listed.
                {writtenAmt > 0n ? ` ${writtenAmt.toString()} sold.` : ""}
              </p>
            ) : (
              <>
                <Field
                  id="solo-offer"
                  label="Amount"
                  suffix={MARKET}
                  value={offerRaw}
                  placeholder={wholeIdle > 0n ? wholeIdle.toString() : "0"}
                  onChange={(e) => setOfferRaw(e.target.value)}
                  inputMode="numeric"
                  hint={
                    wholeIdle > 0n ? (
                      <button
                        type="button"
                        className="link text-[13px]"
                        onClick={() => setOfferRaw(wholeIdle.toString())}
                      >
                        Use free ({wholeIdle.toString()})
                      </button>
                    ) : (
                      "Deposit first"
                    )
                  }
                />
                <div className="mt-4">
                  <Button
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
                    Offer {Number.isInteger(offerLots) && offerLots > 0 ? offerLots : ""} {MARKET}
                  </Button>
                </div>
              </>
            )}
          </Card>

          {listedAmt > 0n || writtenAmt > 0n || usdgAmt > 0n ? (
            <div className="flex flex-wrap gap-2">
              {listedAmt > 0n || writtenAmt > 0n ? (
                <Button
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
                  Close the week
                </Button>
              ) : null}
              {usdgAmt > 0n ? (
                <Button
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
      )}
    </>
  );
}
