import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPnl, validPnlId } from "@/components/v2/PnlData";
import { PnlReceipt } from "@/components/v2/PnlReceipt";
import { receiptImageCopy } from "@/components/v2/PnlText";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

type Params = { id: string };
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await params;
  if (process.env.NEXT_PUBLIC_V2 !== "1") return { title: "StonkHouse", robots: { index: false, follow: true } };
  const pnl = await loadPnl(id);
  const copy = pnl ? receiptImageCopy(pnl) : null;
  const title = copy ? `${copy.multiple} ${pnl?.ticker} outcome — StonkHouse` : "StonkHouse outcome";
  return { title, description: copy ? `${copy.headline}. ${copy.maxLoss}. Inspect the closing transaction.`
    : "Explore verifiable option outcomes on Robinhood Chain.",
    alternates: { canonical: `/pnl/${encodeURIComponent(id)}` },
    openGraph: { title, images: [{ url: `/pnl/${encodeURIComponent(id)}/opengraph-image`, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image" },
    robots: { ...PUBLIC_V2_ROBOTS, index: PUBLIC_V2_ROBOTS.index && pnl !== null } };
}

export default async function PnlPage({ params }: { params: Promise<Params> }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const { id } = await params;
  if (!validPnlId(id)) notFound();
  return <PnlReceipt pnl={await loadPnl(id)} />;
}
