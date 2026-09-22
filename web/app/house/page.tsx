import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HouseOverview } from "@/components/v2/HouseOverview";

export const metadata: Metadata = { title: "House vault — StonkHouse", robots: { index: false, follow: true } };

export default function HousePage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <HouseOverview />;
}
