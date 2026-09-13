import { CHAIN_ID, OVERCALL_MARKET, OVERCALL_ORDERS_URL, VAULT } from "../../lib/env";

/**
 * Relay to Overcall's listings API.
 *
 * Reconstructed from their client bundle and confirmed against the live server
 * (ops/recon/R3-overcall-api.md). The request is deliberately minimal and must stay that way:
 *
 *   POST https://overcall.finance/api/orders?market=NVDA
 *   content-type: application/json      <- the ONLY header. There is no auth, no API key.
 *   { "chainId": 4663, "components": {...}, "signature": "0x<64 or 65 bytes>" }
 *
 * Not `{chainId, order, signature, optionId, maker}` — optionId and maker are derived
 * server-side from `components`, and sending them is a schema error.
 *
 * 201 on insert with `{listing:{orderHash,...}}`; 200 on a repeat of the same order hash, so
 * a keeper retry is idempotent and safe. Errors come back as `{"error":"<string>"}` with
 * 400 schema / 401 signature / 409 counter or duplicate / 422 on-chain facts / 429 rate limit.
 */

const TIMEOUT_MS = 15_000;

/** Overcall's zod schema accepts exactly 64 or 65 bytes. Nothing else gets past the door. */
const SIGNATURE_RE = /^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

export type RelayBody = {
  chainId: number;
  components: Record<string, unknown>;
  signature: string;
};

export type Validation = { ok: true; body: RelayBody } | { ok: false; error: string };

/**
 * Guard the relay so it cannot become an open proxy into somebody else's order book.
 *
 * The only orders this indexer will forward are orders offered by OUR vault. Overcall itself
 * has no maker allowlist, so this restriction is ours, not theirs.
 */
export function validateRelayBody(input: unknown): Validation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const body = input as Record<string, unknown>;

  if (body.chainId !== CHAIN_ID) {
    return { ok: false, error: `chainId must be ${CHAIN_ID}.` };
  }

  const components = body.components;
  if (typeof components !== "object" || components === null) {
    return {
      ok: false,
      error: "components must be an object. Note the field is `components`, not `order`.",
    };
  }

  const offerer = (components as Record<string, unknown>).offerer;
  if (typeof offerer !== "string" || offerer.toLowerCase() !== VAULT.toLowerCase()) {
    return {
      ok: false,
      error: `components.offerer must be this vault (${VAULT}). This relay only publishes our own listings.`,
    };
  }

  const signature = body.signature;
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
    return {
      ok: false,
      error:
        "signature must be 64 or 65 bytes of hex. The vault answers EIP-1271 for the " +
        "authorised hash, but Overcall's schema still rejects any other length.",
    };
  }

  // Extra fields are forwarded untouched: Overcall's schema is strict about the three it
  // knows, and this relay is not the place to silently reshape what the keeper signed.
  return {
    ok: true,
    body: { chainId: body.chainId, components: components as Record<string, unknown>, signature },
  };
}

export type RelayResult = {
  status: number;
  ok: boolean;
  body: unknown;
  url: string;
};

export async function forwardToOvercall(body: RelayBody): Promise<RelayResult> {
  const url = `${OVERCALL_ORDERS_URL}?market=${encodeURIComponent(OVERCALL_MARKET)}`;

  const res = await fetch(url, {
    method: "POST",
    // content-type is the only header their client sends, and adding more has no upside.
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = { error: text };
  }

  return { status: res.status, ok: res.ok, body: parsed, url };
}
