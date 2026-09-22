import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TokenBurnsPanel } from "@/components/v2/TokenBurnsPanel";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

export const metadata: Metadata = {
  title: "Token burns — StonkHouse",
  alternates: { canonical: "/trust/burns" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function TokenBurnsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <TokenBurnsPanel />;
}
