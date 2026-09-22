import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WinsAndLeaderboard } from "@/components/v2/WinsLeaderboard";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

/**
 * The leaderboard is now a TAB on /wins (UX review item 3), but this route is kept.
 *
 * It was unreachable from the nav, not unreachable full stop — anyone with a bookmark or a shared
 * link has a working URL, and deleting the route to fix a discovery problem would turn every one
 * of those into a 404. So the path stays and renders the same page with the leaderboard tab
 * selected. `canonical` points at /wins?tab=leaderboard so the two paths do not compete as
 * separate documents.
 */
export const metadata: Metadata = {
  title: "Leaderboard — StonkHouse", alternates: { canonical: "/wins?tab=leaderboard" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function LeaderboardPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <WinsAndLeaderboard initialTab="leaderboard" />;
}
