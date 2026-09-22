import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LendVault } from "@/components/v2/LendVault";

export const metadata: Metadata = { title: "Lend — StonkHouse", robots: { index: false, follow: true } };

export default function LendPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <LendVault />;
}
