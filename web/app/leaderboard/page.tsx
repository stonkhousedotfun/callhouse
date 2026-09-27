import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WinsAndLeaderboard } from "@/components/v2/WinsLeaderboard";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

/**
 * The full-width leaderboard (Neon). /wins carries the top five in its rail and links here.
 *
 * The route is kept for the reason it always was: bookmarks and shared links to it exist, and deleting it would
 * turn each of them into a 404. `canonical` is now /leaderboard itself. It used to point at /wins?tab=leaderboard,
 * when this route rendered the same page as /wins with a tab selected; /wins never read `?tab`, so that URL showed
 * the feed, and since Neon the two routes are different layouts rather than one document under two paths.
 */
export const metadata: Metadata = {
  title: "Leaderboard — StonkHouse", alternates: { canonical: "/leaderboard" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function LeaderboardPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <WinsAndLeaderboard initialTab="leaderboard" />;
}
