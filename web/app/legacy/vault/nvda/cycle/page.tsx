import { redirect } from "next/navigation";

import { legacyDefaultPath } from "@/app/legacy/routes";

/** Pooled-vault cycle page is retired. 1-lot fills live on /book. */
export default function CycleRedirect() {
  redirect(process.env.NEXT_PUBLIC_V2 === "1" ? legacyDefaultPath("book") : "/book");
}
