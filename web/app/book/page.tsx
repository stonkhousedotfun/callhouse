"use client";

import { useMemo, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useReadContract, useReadContracts, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useTxRunner } from "@/components/TxToast";
import { Button, Card, CardHead, CardTitle, Notice, PageHead, Row, Rows } from "@/components/ui";
import {
  FACTORY,
  MARKET,
  SEAPORT,
  USDG,
  ZERO_CONDUIT_KEY,
  accountFactoryAbi,
  erc20Abi,
  seaportAbi,
  writerAccountAbi,
} from "@/lib/contracts";
import { fmtUsdg, shortAddress } from "@/lib/format";
import type { OrderComponentsJson } from "@/lib/listing";
import { advancedOrderFor } from "@/lib/seaportOrder";

type LotOrder = {
  offerer: Address;
  zone: Address;
  offer: Array<{
    itemType: number;
    token: Address;
    identifierOrCriteria: bigint;
    startAmount: bigint;
    endAmount: bigint;
  }>;
  consideration: Array<{
    itemType: number;
    token: Address;
    identifierOrCriteria: bigint;
    startAmount: bigint;
    endAmount: bigint;
    recipient: Address;
  }>;
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  counter: bigint;
};

function toJson(c: LotOrder): OrderComponentsJson {
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: c.offer.map((item) => ({
      itemType: item.itemType,
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
    })),
    consideration: c.consideration.map((item) => ({
      itemType: item.itemType,
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
      recipient: item.recipient,
    })),
    orderType: c.orderType,
    startTime: c.startTime.toString(),
    endTime: c.endTime.toString(),
    zoneHash: c.zoneHash,
    salt: c.salt.toString(),
    conduitKey: c.conduitKey,
    counter: c.counter.toString(),
  };
}

/**
 * 1-lot book. Each row is one user's full Seaport order of 1 NVDA.
 */
export default function BookPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [busy, setBusy] = useState(false);

  const countRead = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "accountCount",
    query: { enabled: FACTORY !== undefined },
  });
  const count = typeof countRead.data === "bigint" ? Number(countRead.data) : 0;

  const indexCalls = useMemo(() => {
    if (!FACTORY || count === 0) return [];
    return Array.from({ length: count }, (_, i) => ({
      address: FACTORY,
      abi: accountFactoryAbi as unknown as Abi,
      functionName: "accounts" as const,
      args: [BigInt(i)],
    }));
  }, [count]);

  const accountsRead = useReadContracts({
    contracts: indexCalls,
    query: { enabled: indexCalls.length > 0 },
  });
  const accounts = (accountsRead.data ?? [])
    .map((row) => (row.status === "success" ? (row.result as Address) : undefined))
    .filter((a): a is Address => Boolean(a));

  const listedRead = useReadContracts({
    contracts: accounts.map((account) => ({
      address: account,
      abi: writerAccountAbi as unknown as Abi,
      functionName: "listedLots" as const,
    })),
    query: { enabled: accounts.length > 0 },
  });

  const liveRead = useReadContracts({
    contracts: accounts.map((account) => ({
      address: account,
      abi: writerAccountAbi as unknown as Abi,
      functionName: "liveListingCount" as const,
    })),
    query: { enabled: accounts.length > 0 },
  });

  const ownerRead = useReadContracts({
    contracts: accounts.map((account) => ({
      address: account,
      abi: writerAccountAbi as unknown as Abi,
      functionName: "owner" as const,
    })),
    query: { enabled: accounts.length > 0 },
  });

  const lotCalls = useMemo(() => {
    const calls: Array<{ address: Address; abi: Abi; functionName: "lotOrder"; args: [bigint] }> = [];
    accounts.forEach((account, i) => {
      const listed = listedRead.data?.[i]?.status === "success" ? Number(listedRead.data[i].result) : 0;
      const live = liveRead.data?.[i]?.status === "success" ? Number(liveRead.data[i].result) : 0;
      if (listed === 0 || live === 0) return;
      for (let salt = 0; salt < listed; salt++) {
        calls.push({
          address: account,
          abi: writerAccountAbi as unknown as Abi,
          functionName: "lotOrder",
          args: [BigInt(salt)],
        });
      }
    });
    return calls;
  }, [accounts, listedRead.data, liveRead.data]);

  const lotsRead = useReadContracts({
    contracts: lotCalls,
    query: { enabled: lotCalls.length > 0 },
  });

  const week = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "week",
    query: { enabled: FACTORY !== undefined },
  });
  const weekAsk = Array.isArray(week.data) ? (week.data[4] as bigint) : undefined;

  async function fill(order: LotOrder) {
    if (!address) return;
    setBusy(true);
    try {
      const json = toJson(order);
      const advanced = advancedOrderFor(json, 1n, 1n);
      const cost = order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
      await run(
        () =>
          writeContractAsync({
            address: USDG!,
            abi: erc20Abi as unknown as Abi,
            functionName: "approve",
            args: [SEAPORT, cost],
          }),
        { pending: "Approve USDG", success: "Approved" },
      );
      await run(
        () =>
          writeContractAsync({
            address: SEAPORT,
            abi: seaportAbi as unknown as Abi,
            functionName: "fulfillAdvancedOrder",
            args: [advanced, [], ZERO_CONDUIT_KEY, address],
          }),
        { pending: "Fill 1 lot", success: "Filled" },
      );
      void lotsRead.refetch();
      void liveRead.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="1-lot book"
        title={<>One order per contract.</>}
        lede={
          <p>
            Each listing is one {MARKET} call from one user. A fill writes that user&apos;s stock and pays that user
            the premium. Ask this week: {weekAsk !== undefined ? `${fmtUsdg(weekAsk, 3)} USDG` : "—"}.
          </p>
        }
      />

      {FACTORY === undefined ? (
        <Notice tone="warn">The 1-lot factory is not configured (`NEXT_PUBLIC_FACTORY`).</Notice>
      ) : lotCalls.length === 0 ? (
        <Notice tone="info">No live 1-lot orders. Deposit and request a write on Account, then wait for the keeper to list.</Notice>
      ) : (
        <div className="grid gap-3">
          {(lotsRead.data ?? []).map((row, i) => {
            if (row.status !== "success") return null;
            const order = row.result as LotOrder;
            const owner = ownerRead.data?.[accounts.indexOf(lotCalls[i].address)]?.result as Address | undefined;
            const ask = order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
            return (
              <Card key={`${order.offerer}-${order.salt}`}>
                <CardHead>
                  <CardTitle>
                    1 {MARKET} · {fmtUsdg(ask, 3)} USDG
                  </CardTitle>
                </CardHead>
                <Rows>
                  <Row k="Writer" v={shortAddress(owner ?? order.offerer)} />
                  <Row k="Account" v={shortAddress(order.offerer)} />
                  <Row k="Salt" v={order.salt.toString()} />
                </Rows>
                <div className="mt-3">
                  {!isConnected ? (
                    <ConnectButton />
                  ) : (
                    <Button disabled={busy} onClick={() => void fill(order)}>
                      Buy this lot
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
