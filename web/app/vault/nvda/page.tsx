import { permanentRedirect } from "next/navigation";
import LegacyPage from "@/app/legacy/vault/nvda/page";
import { legacyVaultPath } from "@/app/legacy/routes";

export default function VaultPage() {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect(legacyVaultPath());
  return <LegacyPage />;
}
