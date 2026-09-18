import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MakersPage as MakerProgram } from "@/components/v2/MakersPage";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

export const metadata: Metadata = { title: "Market makers — StonkHouse", alternates: { canonical: "/makers" },
  robots: PUBLIC_V2_ROBOTS };

export default function MakersPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <MakerProgram />;
}
