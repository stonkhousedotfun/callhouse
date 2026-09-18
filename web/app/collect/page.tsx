import { permanentRedirect } from "next/navigation";
import LegacyPage from "@/app/legacy/collect/page";

export default function CollectPage() {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect("/legacy/collect");
  return <LegacyPage />;
}
