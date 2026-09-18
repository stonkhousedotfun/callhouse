import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Portfolio } from "@/components/v2/Portfolio";

export const metadata: Metadata = { title: "Portfolio — StonkHouse", robots: { index: false, follow: true } };

export default function PortfolioPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <Portfolio />;
}
