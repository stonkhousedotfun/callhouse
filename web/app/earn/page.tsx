import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LendVault } from "@/components/v2/LendVault";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

/**
 * Earn: the USDG lending vault ("Earn = lending vault"). You deposit USDG and the vault
 * lends it out for interest; at launch it only lends. It was the hidden /lend page; /lend and
 * /lend/rewards now redirect here. The component keeps its internal name (LendVault) and reads the vault from the
 * registry through lendTx.earnVaultAddress(). The self-directed writer feature that used to be /earn is /sell.
 */
export const metadata: Metadata = {
  title: "Earn — StonkHouse", alternates: { canonical: "/earn" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function EarnPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <LendVault />;
}
