"use client";

import { useEffect, useState } from "react";

import { historyStateOf } from "@/components/v2/PriceChart";

export function useDayChange(ticker: string): number | null {
  const [change, setChange] = useState<{ ticker: string; value: number | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/v2/price-history?${new URLSearchParams({ ticker, range: "1D" })}`;
    const load = () => fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (res) => historyStateOf(await res.json().catch(() => null), `HTTP ${res.status}`))
      .catch(() => null)
      .then((state) => {
        if (controller.signal.aborted) return;
        const candles = state?.status === "ok" ? state.body.candles : [];
        const first = candles[0];
        const last = candles.at(-1);
        setChange({ ticker, value: first && last && first.o > 0 ? (last.c - first.o) / first.o : null });
      });
    void load();
    const timer = window.setInterval(() => void load(), 180_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [ticker]);
  return change?.ticker === ticker ? change.value : null;
}

export function changeText(change: number): string {
  const pct = Math.abs(change * 100).toFixed(2);
  return `${change >= 0 ? "+" : "−"}${pct}%`;
}
