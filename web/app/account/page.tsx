"use client";

import { useMemo, useState } from "react";
import type { Abi, Address } from "viem";
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
  accountFactoryAbi,
  erc20Abi,
  stockTokenAbi,
  writerAccountAbi,
} from "@/lib/contracts";
import { fmtAsset, fmtUsdg, parseAmount } from "@/lib/format";

/**
 * Isolated 1-lot account. Your NVDA, your lots, your premium. Not the pooled vault.
 */
export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [depositRaw, setDepositRaw] = useState("");
  const [lotsRaw, setLotsRaw] = useState("1");
  const [busy, setBusy] = useState(false);

  const factoryReady = FACTORY !== undefined;

  const accountRead = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "accountOf",
    args: address ? [address] : undefined,
    query: { enabled: factoryReady && Boolean(address) },
  });
  const account = (typeof accountRead.data === "string" ? accountRead.data : undefined) as Address | undefined;
  const hasAccount = Boolean(account && account !== "0x0000000000000000000000000000000000000000");

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
    abi: erc20Abi as unknown as Abi,
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

  const refresh = () => {
    void accountRead.refetch();
    void idle.refetch();
    void reserved.refetch();
    void requested.refetch();
    void listed.refetch();
    void written.refetch();
    void usdgBal.refetch();
    void allowance.refetch();
  };

  const depositAmt = useMemo(() => parseAmount(depositRaw, ASSET_DECIMALS), [depositRaw]);
  const lots = Number.parseInt(lotsRaw, 10);

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
        eyebrow="1-lot accounts"
        title={<>Your {MARKET}. Your lots.</>}
        lede={
          <p>
            Deposit {MARKET}, choose how many 1-contract calls to write this week, and only those lots can be
            assigned. Unfilled lots come back. This is not the pooled vault.
          </p>
        }
      />

      {!factoryReady ? (
        <Notice tone="warn">The 1-lot factory is not configured (`NEXT_PUBLIC_FACTORY`).</Notice>
      ) : !isConnected ? (
        <ConnectButton />
      ) : !hasAccount ? (
        <Card>
          <CardHead>
            <CardTitle>Create your account</CardTitle>
          </CardHead>
          <p className="mb-4 text-ink-2">A clone that holds only your {MARKET}. One-time.</p>
          <Button
            disabled={busy}
            onClick={() =>
              send(
                () =>
                  writeContractAsync({
                    address: FACTORY!,
                    abi: accountFactoryAbi as unknown as Abi,
                    functionName: "createAccount",
                  }),
                "Create account",
                "Account created",
              )
            }
          >
            Create account
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4">
          <Card>
            <CardHead>
              <CardTitle>Position</CardTitle>
            </CardHead>
            <Rows>
              <Row k="Account" v={<span className="num">{account}</span>} />
              <Row k="Idle" v={`${fmtAsset(idle.data as bigint | undefined)} ${MARKET}`} />
              <Row k="Reserved for listings" v={`${fmtAsset(reserved.data as bigint | undefined)} ${MARKET}`} />
              <Row k="Requested lots" v={String(requested.data ?? "—")} />
              <Row k="Listed lots" v={String(listed.data ?? "—")} />
              <Row k="Written this week" v={String(written.data ?? "—")} />
              <Row k="USDG in account" v={fmtUsdg(usdgBal.data as bigint | undefined)} />
            </Rows>
          </Card>

          <Card>
            <CardHead>
              <CardTitle>Deposit</CardTitle>
            </CardHead>
            <Field
              id="solo-deposit"
              label={`Amount`}
              suffix={MARKET}
              value={depositRaw}
              onChange={(e) => setDepositRaw(e.target.value)}
              inputMode="decimal"
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
                          address: ASSET!,
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
                disabled={busy || depositAmt === null || depositAmt === 0n}
                onClick={() =>
                  send(
                    () =>
                      writeContractAsync({
                        address: account!,
                        abi: writerAccountAbi as unknown as Abi,
                        functionName: "withdraw",
                        args: [depositAmt],
                      }),
                    "Withdraw",
                    "Withdrawn",
                  )
                }
              >
                Withdraw idle
              </Button>
            </div>
          </Card>

          <Card>
            <CardHead>
              <CardTitle>Write this week</CardTitle>
            </CardHead>
            <p className="mb-3 text-ink-2">
              Whole lots only. The keeper posts one full Seaport order per lot. Unfilled lots return at settle.
            </p>
            <Field
              id="solo-lots"
              label="Lots"
              suffix="contracts"
              value={lotsRaw}
              onChange={(e) => setLotsRaw(e.target.value)}
              inputMode="numeric"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busy || !Number.isInteger(lots) || lots < 0}
                onClick={() =>
                  send(
                    () =>
                      writeContractAsync({
                        address: account!,
                        abi: writerAccountAbi as unknown as Abi,
                        functionName: "requestWrite",
                        args: [BigInt(lots)],
                      }),
                    "Request write",
                    "Write requested",
                  )
                }
              >
                Request write
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  send(
                    () =>
                      writeContractAsync({
                        address: account!,
                        abi: writerAccountAbi as unknown as Abi,
                        functionName: "settle",
                      }),
                    "Settle",
                    "Settled",
                  )
                }
              >
                Settle
              </Button>
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
                    "Claim USDG",
                    "Claimed",
                  )
                }
              >
                Claim USDG
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
