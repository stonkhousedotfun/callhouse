"use client";

import { useState } from "react";
import { pnlShareText } from "./PnlText";
import type { PnlResponse } from "@/lib/v2/api-types";

export function PnlShareActions({ pnl, url }: { pnl: PnlResponse; url: string }) {
  const [status, setStatus] = useState("");
  const text = pnlShareText(pnl);
  const imageUrl = `/api/pnl/${encodeURIComponent(pnl.id)}/image?format=square`;
  const xIntent = `https://x.com/intent/post?${new URLSearchParams({ text, url })}`;

  async function copy() {
    try { await navigator.clipboard.writeText(url); setStatus("Link copied"); }
    catch { setStatus("Could not copy the link"); }
  }

  async function share() {
    if (!navigator.share) { await copy(); return; }
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error("image unavailable");
      const file = new File([await response.blob()], `stonkhouse-${pnl.series.ticker.toLowerCase()}-outcome.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: "StonkHouse outcome", text, url, files: [file] });
      else await navigator.share({ title: "StonkHouse outcome", text, url });
      setStatus("Shared");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      try { await navigator.share({ title: "StonkHouse outcome", text, url }); setStatus("Shared"); }
      catch { setStatus("Could not share. You can copy the link instead."); }
    }
  }

  const button = "inline-flex min-h-11 items-center justify-center rounded-md border border-line-2 bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return <div className="mt-7">
    <div className="flex flex-wrap gap-3">
      <a className={button} href={xIntent} target="_blank" rel="noopener noreferrer">Share on X</a>
      <button className={button} type="button" onClick={copy}>Copy link</button>
      <button className={button} type="button" onClick={share}>Share</button>
      <a className={button} href={imageUrl} download={`stonkhouse-${pnl.series.ticker.toLowerCase()}-outcome.png`}>Save image</a>
    </div>
    <p className="mt-2 min-h-5 text-sm text-ink-2" role="status" aria-live="polite">{status}</p>
  </div>;
}
