import { notFound, permanentRedirect } from "next/navigation";

/** The lending vault is Earn now; old /lend links land on /earn. */
export default function LendRedirect() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  permanentRedirect("/earn");
}
