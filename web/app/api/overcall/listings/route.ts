import { NextResponse } from "next/server";

import { VAULT } from "@/lib/contracts";
import { isOvercallListing } from "@/lib/overcall";

/**
 * Read-only passthrough to Overcall's public order book, for this vault only.
 *
 * WHY this exists: overcall.finance returns no `Access-Control-Allow-Origin` header
 * (ops/recon/R3-overcall-api.md §5.2), so the browser cannot call `/api/orders` from our origin.
 * This handler does it server-side.
 *
 * WHAT IT WILL NOT DO: POST. Publishing a listing is the keeper's job — it happens after
 * `vault.approveListing(components)` has authorised the order hash on-chain, and it must never
 * be triggerable from a web page. GET only, no request body.
 *
 * WHAT IT WILL NOT FORWARD: anything the browser sent. The upstream URL is built from the
 * compiled-in base, the compiled-in vault address, a fixed status and a fixed limit, and nothing
 * else — the request's query string is not read at all. So this route cannot be used to read
 * other writers' books, to probe their validator with odd parameters, or to spend their per-IP
 * rate bucket on our behalf with arbitrary requests. `market=` is deliberately not sent either:
 * it narrows the answer to the registry's current-cycle option ids (recon C6), which would hide
 * the vault's earlier orders, and no page asks for that view.
 *
 * WHAT IT WILL NOT PASS THROUGH: rows that do not parse. Every element of `listings` goes through
 * isOvercallListing() and the ones that fail are dropped and counted, so the page only ever sees
 * rows whose every field has the shape the fill path expects. The page then runs its own
 * "is this ours" check against the chain (lib/overcall.ts); this route is the shape gate, not
 * the trust gate. The body is capped before it is parsed — a multi-megabyte answer is not a
 * book, it is a problem, and JSON.parse on it would be ours.
 *
 * Upstream error bodies are never forwarded. A non-2xx answers 502 with one line of our own
 * words; their message may be anything and the page prints what it is given.
 *
 * Their API takes no auth of any kind: no key, no bearer, no cookie. The only header their own
 * client sends is `content-type` on POST, and reads need nothing at all.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OVERCALL_BASE = (process.env.OVERCALL_API_BASE ?? "https://overcall.finance").replace(/\/+$/, "");

/** Enough for the 20-open-listing cap and a long history, with room. A row is about 2 KiB. */
const MAX_UPSTREAM_BYTES = 512 * 1024;
/** Overcall accepts 1..200 (recon C5). 20 open is their per-writer cap; history is short-lived. */
const LIMIT = 50;

function bad(message: string, status: number) {
  return NextResponse.json({ listings: [], error: message }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET() {
  if (VAULT === undefined) {
    return bad("This build has no vault address configured, so there is no book to read.", 503);
  }

  // `status=all` is only legal together with `offerer` (recon §5.5) and is exactly the query the
  // cycle page wants: every order this vault has ever posted, in whatever state.
  const forward = new URLSearchParams();
  forward.set("offerer", VAULT);
  forward.set("status", "all");
  forward.set("limit", String(LIMIT));

  const target = `${OVERCALL_BASE}/api/orders?${forward.toString()}`;

  let res: Response;
  try {
    res = await fetch(target, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(9000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return bad(timedOut ? "Overcall did not answer within 9 seconds." : "Overcall could not be reached.", 502);
  }

  if (!res.ok) {
    // Their status is reported, their body is not. A 429 from their per-IP bucket is not a
    // client error on our side, and whatever prose they attach is theirs, not ours to print.
    return bad(`Overcall answered HTTP ${res.status}.`, 502);
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
    return bad("Overcall's answer was larger than a book should be.", 502);
  }

  let text: string;
  try {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_UPSTREAM_BYTES) {
      return bad("Overcall's answer was larger than a book should be.", 502);
    }
    text = new TextDecoder().decode(bytes);
  } catch {
    return bad("Overcall's answer could not be read.", 502);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return bad("Overcall's answer was not JSON.", 502);
  }

  const raw =
    payload && typeof payload === "object" && Array.isArray((payload as { listings?: unknown }).listings)
      ? (payload as { listings: unknown[] }).listings
      : null;
  if (raw === null) return bad("Overcall's answer did not contain a listings array.", 502);

  const listings = raw.filter(isOvercallListing);
  const dropped = raw.length - listings.length;

  return NextResponse.json({ listings, dropped }, { status: 200, headers: { "cache-control": "no-store" } });
}
