import { permanentRedirect, redirect } from "next/navigation";
import { legacyVaultPath } from "@/app/legacy/routes";

export default function CyclePage() {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect(legacyVaultPath("/cycle"));
  redirect("/book");
}
