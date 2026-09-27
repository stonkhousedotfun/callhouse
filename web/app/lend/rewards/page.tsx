import { notFound, permanentRedirect } from "next/navigation";

/** Lender rewards moved with the vault to /earn/rewards. */
export default function LendRewardsRedirect() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  permanentRedirect("/earn/rewards");
}
