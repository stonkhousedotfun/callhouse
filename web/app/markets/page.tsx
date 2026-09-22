import { notFound, permanentRedirect } from "next/navigation";

/**
 * /markets was the market directory's first address and a top-level nav entry. The directory is a
 * market STATUS reference, not a shopping surface, so it moved under Trust as /trust/markets (UX
 * review 2026-09-20, section 2) and left the nav. This route keeps every old link and bookmark
 * working with a permanent redirect (308), permanent because the move is a fact about the URL,
 * unlike /account's temporary one, which follows a default-market choice that can change.
 */
export default function MarketsRedirect() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  permanentRedirect("/trust/markets");
}
