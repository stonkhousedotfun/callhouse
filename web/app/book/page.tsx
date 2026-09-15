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
  seaportAbi,
  stockTokenAbi,
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

export default function BookPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const run = useTxRunner();
  const [busy, setBusy] = useState(false);

  const countRead = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "accountCount",
  });
  const count = typeof countRead.data === "bigint" ? Number(countRead.data) : 0;

  const indexCalls = useMemo(() => {
    if (count === 0) return [];
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

  const hashCalls = useMemo(() => {
    return (lotsRead.data ?? []).flatMap((row) => {
      if (row.status !== "success") return [];
      return [
        {
          address: SEAPORT,
          abi: seaportAbi as unknown as Abi,
          functionName: "getOrderHash" as const,
          args: [row.result as LotOrder],
        },
      ];
    });
  }, [lotsRead.data]);

  const hashesRead = useReadContracts({
    contracts: hashCalls,
    query: { enabled: hashCalls.length > 0 },
  });

  const statusCalls = useMemo(() => {
    return (hashesRead.data ?? []).flatMap((row) => {
      if (row.status !== "success") return [];
      return [
        {
          address: SEAPORT,
          abi: seaportAbi as unknown as Abi,
          functionName: "getOrderStatus" as const,
          args: [row.result as Hex],
        },
      ];
    });
  }, [hashesRead.data]);

  const statusRead = useReadContracts({
    contracts: statusCalls,
    query: { enabled: statusCalls.length > 0 },
  });

  const week = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "week",
  });
  const weekId = (() => {
    const d = week.data;
    if (!d) return 0;
    if (Array.isArray(d)) return Number(d[0] ?? 0);
    return Number((d as { id?: number }).id ?? 0);
  })();
  const weekAsk = (() => {
    const d = week.data;
    if (!d) return undefined;
    if (Array.isArray(d)) return d[4] as bigint | undefined;
    return (d as { askUsdg?: bigint }).askUsdg;
  })();

  const liveRows = useMemo(() => {
    const out: Array<{ order: LotOrder; owner?: Address }> = [];
    (lotsRead.data ?? []).forEach((row, i) => {
      if (row.status !== "success") return;
      const status = statusRead.data?.[i];
      if (status?.status === "success") {
        const [validated, cancelled, filled, size] = status.result as [boolean, boolean, bigint, bigint];
        if (!validated || cancelled || (size > 0n && filled >= size)) return;
      }
      const order = row.result as LotOrder;
      const owner = ownerRead.data?.[accounts.indexOf(lotCalls[i].address)]?.result as Address | undefined;
      out.push({ order, owner });
    });
    return out;
  }, [lotsRead.data, statusRead.data, ownerRead.data, accounts, lotCalls]);

  async function fill(order: LotOrder) {
    if (!address) return;
    setBusy(true);
    try {
      const json = toJson(order);
      const advanced = advancedOrderFor(json, 1n, 1n);
      const cost = order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
      const approved = await run(
        () =>
          writeContractAsync({
            address: USDG,
            abi: stockTokenAbi as unknown as Abi,
            functionName: "approve",
            args: [SEAPORT, cost],
          }),
        { pending: "Approve USDG", success: "Approved" },
      );
      if (!approved) return;
      await run(
        () =>
          writeContractAsync({
            address: SEAPORT,
            abi: seaportAbi as unknown as Abi,
            functionName: "fulfillAdvancedOrder",
            args: [advanced, [], ZERO_CONDUIT_KEY, address],
          }),
        { pending: "Buy", success: "Bought" },
      );
      void lotsRead.refetch();
      void liveRead.refetch();
      void statusRead.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow={MARKET}
        title={<>This week.</>}
        lede={
          <p>
            Each offer is one {MARKET} from one person. If you buy, they get paid and you get the call.
            {weekAsk !== undefined && weekId > 0 ? ` This week: ${fmtUsdg(weekAsk, 3)} USDG each.` : ""}
          </p>
        }
      />

      {weekId === 0 ? (
        <Notice tone="info">Nothing is for sale yet this week.</Notice>
      ) : liveRows.length === 0 ? (
        <Notice tone="info">Nothing is for sale right now. Check back after someone offers their {MARKET}.</Notice>
      ) : (
        <div className="grid gap-3">
          {liveRows.map(({ order, owner }) => {
            const ask = order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
            return (
              <Card key={`${order.offerer}-${order.salt.toString()}`}>
                <CardHead>
                  <CardTitle>
                    1 {MARKET} · {fmtUsdg(ask, 3)} USDG
                  </CardTitle>
                </CardHead>
                <Rows>
                  <Row k="From" v={shortAddress(owner ?? order.offerer)} />
                </Rows>
                <div className="mt-3">
                  {!isConnected ? (
                    <ConnectButton />
                  ) : (
                    <Button disabled={busy} onClick={() => void fill(order)}>
                      Buy
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
