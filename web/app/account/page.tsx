"use client";

import { useMemo, useState } from "react";
import { formatUnits, type Abi, type Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useTxRunner } from "@/components/TxToast";
import { Button, Card, CardHead, CardTitle, Field, Notice, PageHead, Row, Rows } from "@/components/ui";
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

export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [depositRaw, setDepositRaw] = useState("");
  const [offerRaw, setOfferRaw] = useState("1");
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
  const offerLots = Number.parseInt(offerRaw, 10);

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
        lede={
          <p>
            Put {MARKET} in. Choose how much is for sale this week. If someone pays, you get USDG. If they don&apos;t,
            you keep the stock.
          </p>
        }
      />

      {!isConnected ? (
        <Card>
          <CardHead>
            <CardTitle>Connect a wallet</CardTitle>
          </CardHead>
          <p className="mb-4 text-ink-2">MetaMask or Phantom, on Robinhood Chain.</p>
          <ConnectButton block />
        </Card>
      ) : !hasAccount ? (
        <Card>
          <CardHead>
            <CardTitle>Open an account</CardTitle>
          </CardHead>
          <p className="mb-4 text-ink-2">One-time. It holds only your {MARKET}.</p>
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
        <div className="grid gap-4">
          {weekId === 0 ? (
            <Notice tone="info">This week is not open for offers yet. You can still deposit.</Notice>
          ) : null}

          <Card>
            <CardHead>
              <CardTitle>Position</CardTitle>
            </CardHead>
            <Rows>
              <Row k="In the wallet" v={`${fmtAsset(walletAmt)} ${MARKET}`} />
              <Row k="In the account" v={`${fmtAsset(idleAmt + reservedAmt)} ${MARKET}`} />
              <Row k="Available to take out" v={`${fmtAsset(idleAmt)} ${MARKET}`} />
              <Row k="For sale this week" v={`${requestedAmt.toString()} ${MARKET}`} />
              <Row k="Listed" v={listedAmt === 0n ? "Not yet" : `${listedAmt.toString()} ${MARKET}`} />
              <Row k="Sold this week" v={`${writtenAmt.toString()} ${MARKET}`} />
              <Row k="USDG waiting" v={fmtUsdg(usdgAmt)} />
            </Rows>
          </Card>

          <Card>
            <CardHead>
              <CardTitle>Deposit or take out</CardTitle>
            </CardHead>
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
                  Max in wallet: {fmtAsset(walletAmt)}
                </button>
              }
            />
            <div className="mt-3 flex flex-wrap gap-2">
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
                Take out available
              </Button>
            </div>
          </Card>

          <Card>
            <CardHead>
              <CardTitle>For sale this week</CardTitle>
            </CardHead>
            <p className="mb-3 text-ink-2">
              Whole {MARKET} only. Only this amount can be sold. The rest stays yours.
            </p>
            <Field
              id="solo-offer"
              label="Amount"
              suffix={MARKET}
              value={offerRaw}
              onChange={(e) => setOfferRaw(e.target.value)}
              inputMode="numeric"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busy || !Number.isInteger(offerLots) || offerLots < 0 || listedAmt !== 0n}
                onClick={() =>
                  send(
                    () =>
                      writeContractAsync({
                        address: account!,
                        abi: writerAccountAbi as unknown as Abi,
                        functionName: "requestWrite",
                        args: [BigInt(offerLots)],
                      }),
                    "Set amount",
                    "Amount set",
                  )
                }
              >
                Set amount
              </Button>
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
                  variant="ghost"
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
                  Collect USDG
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
