import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TokenBurnsRoute } from "@/components/v2/TokenBurnsPanel";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

export const metadata: Metadata = {
  title: "Token burns — StonkHouse",
  alternates: { canonical: "/trust/burns" },
  robots: PUBLIC_V2_ROBOTS,
};

/**
 * The route always renders a heading. The burns PANEL alone returns nothing while loading, on an error,
 * when the splitter is not configured and before the first recorded burn, which left this page blank.
 */
export default function TokenBurnsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <TokenBurnsRoute />;
}
