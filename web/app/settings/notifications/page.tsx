import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotificationSettings } from "@/components/v2/NotificationSettings";

export const metadata: Metadata = { title: "Notifications — StonkHouse", robots: { index: false, follow: true } };

export default function NotificationSettingsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <NotificationSettings />;
}
