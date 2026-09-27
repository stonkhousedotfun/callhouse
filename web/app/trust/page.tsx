import { notFound, permanentRedirect } from "next/navigation";

/**
 * The Trust landing (control addresses, delayed roles, scheduled operations, audit status) moved to
 * the docs. The market status page under
 * it stays; old links and bookmarks land there.
 */
export default function TrustRoute() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  permanentRedirect("/trust/markets");
}
