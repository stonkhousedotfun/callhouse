import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Leaderboard } from "@/components/v2/WinsLeaderboard";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

export const metadata: Metadata = {
  title: "Leaderboard — StonkHouse", alternates: { canonical: "/leaderboard" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function LeaderboardPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <Leaderboard />;
}
