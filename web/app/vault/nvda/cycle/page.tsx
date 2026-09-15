import { redirect } from "next/navigation";

/** Pooled-vault cycle page is retired. 1-lot fills live on /book. */
export default function CycleRedirect() {
  redirect("/book");
}
