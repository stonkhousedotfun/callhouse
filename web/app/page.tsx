import type { Metadata } from "next";

import LegacyHome from "./legacy/LegacyHome";
import { Marketplace } from "@/components/v2/Marketplace";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

export const metadata: Metadata = {
  robots: PUBLIC_V2_ROBOTS,
};

export default function HomePage() {
  return process.env.NEXT_PUBLIC_V2 === "1" ? <Marketplace /> : <LegacyHome />;
}
