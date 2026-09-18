import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WinsFeed } from "@/components/v2/WinsLeaderboard";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

export const metadata: Metadata = {
  title: "Recent wins — StonkHouse", alternates: { canonical: "/wins" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function WinsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <WinsFeed />;
}
