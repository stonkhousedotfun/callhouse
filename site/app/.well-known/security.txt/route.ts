/**
 * /.well-known/security.txt — RFC 9116, the file a researcher looks for before anything else.
 *
 * WHY IT LIVES HERE: callhouse.xyz is the indexed domain and the one a stranger reaches first;
 * SECURITY.md §6 points at this path. It is a route handler rather than a file in public/
 * because the Contact line is NEXT_PUBLIC_SECURITY_CONTACT_EMAIL from lib/legal.ts and the
 * Expires line is derived from LEGAL_DOCS_VERSION — a static file would have to be edited by
 * hand in step with both, and would drift.
 *
 * WHILE NO SECURITY CONTACT IS SET THIS ROUTE RETURNS 404, on purpose. RFC 9116 §2.5.3 makes
 * `Contact:` mandatory, and a security.txt with no way to reach anyone is worse than none:
 * scanners parse it as a valid policy and stop looking, and a researcher who finds it reads
 * "this project thought about disclosure" on a file that says nothing. A 404 tells the truth
 * (there is no disclosure address yet), and the body says so in one line so it is not mistaken
 * for a missing route. ops/launch-legal.md lists setting the address as a launch step; until
 * then SECURITY.md §6 carries the same gap in words.
 *
 * `dynamic = "force-static"`: every input is a build-time constant (NEXT_PUBLIC_* is inlined by
 * `next build`, LEGAL_DOCS_VERSION is a literal, and securityTxtExpires() reads no clock), so
 * the response is the same bytes for the life of the image and Next can emit it at build. A
 * change to the address is a rebuild, exactly like every other NEXT_PUBLIC_* on this site.
 *
 * Deliberately absent: `Encryption:` (no PGP key has been published — adding a key nobody
 * checks is the same mistake as a mailbox nobody reads), `Acknowledgments:` (there is nothing
 * to acknowledge yet), `Hiring:`, and a signature (RFC 9116 §2.3 recommends one, which needs
 * the same key; it is on the launch checklist, not in the code).
 */
import { SECURITY_CONTACT_EMAIL, securityTxtExpires } from "@/lib/legal";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;

export function GET(): Response {
  if (!SECURITY_CONTACT_EMAIL) {
    return new Response(
      "No vulnerability-disclosure address has been designated for this interface yet. See /legal#reporting.\n",
      { status: 404, headers: TEXT },
    );
  }

  // Field order follows the RFC's examples: Contact first, then Expires, then the optional lines.
  const body = [
    `Contact: mailto:${SECURITY_CONTACT_EMAIL}`,
    `Expires: ${securityTxtExpires()}`,
    "Preferred-Languages: en",
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    `Policy: ${SITE_URL}/legal#reporting`,
    "",
  ].join("\n");

  return new Response(body, { status: 200, headers: TEXT });
}
