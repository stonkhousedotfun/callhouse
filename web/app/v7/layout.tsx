import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Legacy v7 run-off — StonkHouse",
  robots: { index: false, follow: true },
};

export default function V7Layout({ children }: { children: React.ReactNode }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1" || !process.env.NEXT_PUBLIC_V7_API_URL?.trim()) notFound();
  return children;
}
