import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EarnOverview } from "@/components/v2/EarnOverview";

export const metadata: Metadata = { title: "Earn — StonkHouse", robots: { index: false, follow: true } };

export default function EarnPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <EarnOverview />;
}
