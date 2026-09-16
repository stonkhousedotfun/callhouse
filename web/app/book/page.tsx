"use client";

import { useMemo, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useBlock, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useTxRunner } from "@/components/TxToast";
import { Button, Card, CardHead, CardTitle, Notice, PageHead, Row, Rows } from "@/components/ui";
import { CHAIN_ID } from "@/lib/chain";
import {
  CLEARINGHOUSE,
  FACTORY,
  MARKET,
  SEAPORT,
  USDG,
  ZERO_CONDUIT_KEY,
  ZERO_HASH,
  accountFactoryAbi,
  seaportAbi,
  stockTokenAbi,
  valoremClearAbi,
  writerAccountAbi,
} from "@/lib/contracts";
import { approvalFor, exerciseAmounts, exerciseWindow } from "@/lib/exercise";
import { parseFactoryWeek } from "@/lib/factoryWeek";
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

function asBig(value: unknown): bigint {
  return BigInt(value as bigint);
}

function asLotOrder(data: unknown): LotOrder | undefined {
  if (data === null || data === undefined || typeof data !== "object") return undefined;
  const rec = data as Record<string, unknown>;
  const inner = rec.c && typeof rec.c === "object" ? (rec.c as Record<string, unknown>) : rec;
  const offerer = inner.offerer ?? inner[0];
  const zone = inner.zone ?? inner[1];
  const offer = inner.offer ?? inner[2];
  const consideration = inner.consideration ?? inner[3];
  const orderType = inner.orderType ?? inner[4];
  const startTime = inner.startTime ?? inner[5];
  const endTime = inner.endTime ?? inner[6];
  const zoneHash = inner.zoneHash ?? inner[7];
  const salt = inner.salt ?? inner[8];
  const conduitKey = inner.conduitKey ?? inner[9];
  const counter = inner.counter ?? inner[10];
  if (
    typeof offerer !== "string" ||
    typeof zone !== "string" ||
    !Array.isArray(offer) ||
    !Array.isArray(consideration) ||
    orderType === undefined ||
    startTime === undefined ||
    endTime === undefined ||
    typeof zoneHash !== "string" ||
    salt === undefined ||
    typeof conduitKey !== "string" ||
    counter === undefined
  ) {
    return undefined;
  }
  const items = (rows: unknown[]) =>
    rows.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        itemType: Number(item.itemType ?? item[0]),
        token: (item.token ?? item[1]) as Address,
        identifierOrCriteria: asBig(item.identifierOrCriteria ?? item[2]),
        startAmount: asBig(item.startAmount ?? item[3]),
        endAmount: asBig(item.endAmount ?? item[4]),
        recipient: (item.recipient ?? item[5]) as Address,
      };
    });
  return {
    offerer: offerer as Address,
    zone: zone as Address,
    offer: items(offer),
    consideration: items(consideration),
    orderType: Number(orderType),
    startTime: asBig(startTime),
    endTime: asBig(endTime),
    zoneHash: zoneHash as Hex,
    salt: asBig(salt),
    conduitKey: conduitKey as Hex,
    counter: asBig(counter),
  };
}

function asOption(data: unknown): {
  exerciseAmount: bigint;
  underlyingAmount: bigint;
  exerciseTs: number;
  expiryTs: number;
} | undefined {
  if (data === null || data === undefined || typeof data !== "object") return undefined;
  const rec = data as Record<string, unknown>;
  const exerciseAmount = rec.exerciseAmount ?? rec[3];
  const underlyingAmount = rec.underlyingAmount ?? rec[1];
  const exerciseTs = rec.exerciseTimestamp ?? rec[4];
  const expiryTs = rec.expiryTimestamp ?? rec[5];
  if (exerciseAmount === undefined || underlyingAmount === undefined || exerciseTs === undefined || expiryTs === undefined) {
    return undefined;
  }
  return {
    exerciseAmount: BigInt(exerciseAmount as bigint),
    underlyingAmount: BigInt(underlyingAmount as bigint),
    exerciseTs: Number(exerciseTs),
    expiryTs: Number(expiryTs),
  };
}

export default function BookPage() {
  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const run = useTxRunner();
  const notice = useNotice();
  const [busy, setBusy] = useState(false);
  const { data: block } = useBlock({
    chainId: CHAIN_ID,
    query: { refetchInterval: 15_000 },
  });
  const chainNow = block?.timestamp !== undefined ? Number(block.timestamp) : undefined;

  const countRead = useReadContract({
    address: FACTORY,
    abi: accountFactoryAbi as unknown as Abi,
    functionName: "liveCount",
  });
  const count = typeof countRead.data === "bigint" ? Number(countRead.data) : 0;

  const indexCalls = useMemo(() => {
    if (count === 0) return [];
    return Array.from({ length: count }, (_, i) => ({
      address: FACTORY,
      abi: accountFactoryAbi as unknown as Abi,
      functionName: "liveAt" as const,
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
      const order = asLotOrder(row.result);
      if (row.status !== "success" || !order) return [];
      return [
        {
          address: SEAPORT,
          abi: seaportAbi as unknown as Abi,
          functionName: "getOrderHash" as const,
          args: [order] as const,
        },
      ];
    });
  }, [lotsRead.data]);

  const hashesRead = useReadContracts({
    contracts: hashCalls,
    query: { enabled: hashCalls.length > 0 },
  });

  // 1:1 with hashCalls so a failed getOrderHash cannot shift getOrderStatus onto a neighbour.
  const statusCalls = useMemo(() => {
    return (hashesRead.data ?? []).map((row) => ({
      address: SEAPORT,
      abi: seaportAbi as unknown as Abi,
      functionName: "getOrderStatus" as const,
      args: [row.status === "success" ? (row.result as Hex) : ZERO_HASH] as const,
    }));
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
  const parsedWeek = parseFactoryWeek(week.data);
  const weekReady = week.isSuccess || week.isError;
  const weekOpen = Boolean(parsedWeek && parsedWeek.id > 0);
  const weekAsk = parsedWeek?.askUsdg;

  const optionIdRead = useReadContracts({
    contracts: accounts.map((account) => ({
      address: account,
      abi: writerAccountAbi as unknown as Abi,
      functionName: "optionId" as const,
    })),
    query: { enabled: accounts.length > 0 },
  });

  const holdRead = useReadContracts({
    contracts:
      address && optionIdRead.data
        ? accounts.map((_, i) => {
            const id = optionIdRead.data[i]?.status === "success" ? (optionIdRead.data[i].result as bigint) : 0n;
            return {
              address: CLEARINGHOUSE,
              abi: valoremClearAbi as unknown as Abi,
              functionName: "balanceOf" as const,
              args: [address, id] as const,
            };
          })
        : [],
    query: { enabled: Boolean(address) && Boolean(optionIdRead.data) },
  });

  const heldIds = useMemo(() => {
    const ids: bigint[] = [];
    const seen = new Set<string>();
    accounts.forEach((_, i) => {
      const id = optionIdRead.data?.[i]?.status === "success" ? (optionIdRead.data[i].result as bigint) : 0n;
      const bal = holdRead.data?.[i]?.status === "success" ? (holdRead.data[i].result as bigint) : 0n;
      if (id === 0n || bal === 0n) return;
      const key = id.toString();
      if (seen.has(key)) return;
      seen.add(key);
      ids.push(id);
    });
    return ids;
  }, [accounts, optionIdRead.data, holdRead.data]);

  const heldInfoRead = useReadContracts({
    contracts: heldIds.map((id) => ({
      address: CLEARINGHOUSE,
      abi: valoremClearAbi as unknown as Abi,
      functionName: "option" as const,
      args: [id] as const,
    })),
    query: { enabled: heldIds.length > 0 },
  });

  const heldRows = useMemo(() => {
    const out: Array<{
      optionId: bigint;
      balance: bigint;
      window: ReturnType<typeof exerciseWindow>;
    }> = [];
    const infoById = new Map<string, ReturnType<typeof asOption>>();
    heldIds.forEach((id, i) => {
      const row = heldInfoRead.data?.[i];
      if (row?.status === "success") infoById.set(id.toString(), asOption(row.result));
    });
    accounts.forEach((_, i) => {
      const id = optionIdRead.data?.[i]?.status === "success" ? (optionIdRead.data[i].result as bigint) : 0n;
      const bal = holdRead.data?.[i]?.status === "success" ? (holdRead.data[i].result as bigint) : 0n;
      if (id === 0n || bal === 0n) return;
      if (out.some((row) => row.optionId === id)) return;
      const opt = infoById.get(id.toString());
      out.push({
        optionId: id,
        balance: bal,
        window: exerciseWindow(
          opt ? { exerciseTs: opt.exerciseTs, expiryTs: opt.expiryTs } : undefined,
          chainNow,
        ),
      });
    });
    return out;
  }, [accounts, optionIdRead.data, holdRead.data, heldIds, heldInfoRead.data, chainNow]);

  const liveRows = useMemo(() => {
    const out: Array<{ order: LotOrder; owner?: Address }> = [];
    let successIdx = 0;
    (lotsRead.data ?? []).forEach((row, i) => {
      if (row.status !== "success") return;
      const hashIdx = successIdx;
      successIdx += 1;
      const hashRow = hashesRead.data?.[hashIdx];
      const status = hashRow?.status === "success" ? statusRead.data?.[hashIdx] : undefined;
      if (status?.status === "success") {
        const [validated, cancelled, filled, size] = status.result as [boolean, boolean, bigint, bigint];
        if (!validated || cancelled || (size > 0n && filled >= size)) return;
      }
      const order = asLotOrder(row.result);
      if (!order) return;
      const owner = ownerRead.data?.[accounts.indexOf(lotCalls[i].address)]?.result as Address | undefined;
      out.push({ order, owner });
    });
    return out;
  }, [lotsRead.data, hashesRead.data, statusRead.data, ownerRead.data, accounts, lotCalls]);

  const write = (args: Parameters<typeof writeContractAsync>[0]) =>
    writeContractAsync({ ...args, chainId: CHAIN_ID });

  async function approveUsdg(spender: Address, total: bigint): Promise<boolean> {
    if (!address || !publicClient) return false;
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({
        address: USDG,
        abi: stockTokenAbi as unknown as Abi,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: USDG,
        abi: stockTokenAbi as unknown as Abi,
        functionName: "allowance",
        args: [address, spender],
      }) as Promise<bigint>,
    ]);
    if (balance < total) {
      notice("error", "Not enough USDG", `Need ${fmtUsdg(total)} USDG in this wallet.`);
      return false;
    }
    const needed = approvalFor(allowance, total);
    if (needed === undefined) return false;
    if (needed === 0n) return true;
    const approved = await run(
      () =>
        write({
          address: USDG,
          abi: stockTokenAbi as unknown as Abi,
          functionName: "approve",
          args: [spender, needed],
        }),
      { pending: "Approve USDG", success: "Approved" },
    );
    return Boolean(approved);
  }

  async function exercise(optionId: bigint, amount: bigint) {
    if (!address || !publicClient) return;
    if (chainId !== CHAIN_ID) {
      notice("error", "Wrong network", "Switch to Robinhood Chain.");
      return;
    }
    setBusy(true);
    try {
      const raw = await publicClient.readContract({
        address: CLEARINGHOUSE,
        abi: valoremClearAbi as unknown as Abi,
        functionName: "option",
        args: [optionId],
      });
      const opt = asOption(raw);
      if (!opt) {
        notice("error", "Exercise not sent", "Could not read this call.");
        return;
      }
      const window = exerciseWindow({ exerciseTs: opt.exerciseTs, expiryTs: opt.expiryTs }, Number(await publicClient.getBlock().then((b) => b.timestamp)));
      if (window === "before") {
        notice("error", "Exercise not sent", "The exercise window has not opened yet.");
        return;
      }
      if (window === "expired") {
        notice("error", "Exercise not sent", "This call has expired.");
        return;
      }
      const on = Boolean(
        await publicClient.readContract({
          address: CLEARINGHOUSE,
          abi: valoremClearAbi as unknown as Abi,
          functionName: "feesEnabled",
        }),
      );
      const bps = Number(
        await publicClient.readContract({
          address: CLEARINGHOUSE,
          abi: valoremClearAbi as unknown as Abi,
          functionName: "feeBps",
        }),
      );
      const amounts = exerciseAmounts({
        amount,
        strikeUsdg: opt.exerciseAmount,
        underlyingAmount: opt.underlyingAmount,
        feesEnabled: on,
        feeBps: bps,
      });
      if (!amounts) {
        notice("error", "Exercise not sent", "Could not size this exercise.");
        return;
      }
      if (!(await approveUsdg(CLEARINGHOUSE, amounts.total))) return;
      await run(
        () =>
          write({
            address: CLEARINGHOUSE,
            abi: valoremClearAbi as unknown as Abi,
            functionName: "exercise",
            args: [optionId, amount],
          }),
        { pending: "Exercise", success: "Exercised" },
      );
      void holdRead.refetch();
    } finally {
      setBusy(false);
    }
  }

  async function fill(order: LotOrder) {
    if (!address) return;
    if (chainId !== CHAIN_ID) {
      notice("error", "Wrong network", "Switch to Robinhood Chain.");
      return;
    }
    setBusy(true);
    try {
      const json = toJson(order);
      const advanced = advancedOrderFor(json, 1n, 1n);
      const cost = order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
      if (!(await approveUsdg(SEAPORT, cost))) return;
      await run(
        () =>
          write({
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
            {weekAsk !== undefined && weekOpen ? ` This week: ${fmtUsdg(weekAsk, 3)} USDG each.` : ""}
          </p>
        }
      />

      {heldRows.length > 0 ? (
        <div className="mb-6 grid gap-3">
          <h2 className="text-lg font-bold tracking-[-0.015em]">Yours to exercise</h2>
          {heldRows.map((row) => {
            const ready = row.window === "open";
            const label =
              row.window === "before" ? "Opens later" : row.window === "expired" ? "Expired" : row.window === "unknown" ? "Exercise" : "Exercise";
            return (
              <Card key={row.optionId.toString()}>
                <CardHead>
                  <CardTitle>
                    {row.balance.toString()} {MARKET} call
                  </CardTitle>
                </CardHead>
                <div className="mt-3">
                  <Button
                    disabled={busy || !ready || !isConnected || chainId !== CHAIN_ID}
                    onClick={() => void exercise(row.optionId, row.balance)}
                  >
                    {label}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}

      {!weekReady ? (
        <Notice tone="info">Loading this week.</Notice>
      ) : !weekOpen ? (
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
                  {!isConnected || chainId !== CHAIN_ID ? (
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
