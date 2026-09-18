import { permanentRedirect } from "next/navigation";
import LegacyPage from "@/app/legacy/activity/page";

export default function ActivityPage() {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect("/legacy/activity");
  return <LegacyPage />;
}
