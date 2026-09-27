/**
 * POST /api/csp-report — where the browser sends Content-Security-Policy-Report-Only violations
 * next.config.mjs names this path twice in the report-only policy: `report-uri` for
 * browsers that only speak the CSP2 format, and `report-to csp` with a `Reporting-Endpoints` header
 * for browsers that speak the Reporting API.
 *
 * WHAT ARRIVES. Two formats, told apart by Content-Type:
 * - `application/csp-report` (report-uri): one object, `{"csp-report": {"document-uri", "blocked-uri",
 *   "violated-directive", "effective-directive", ...}}`.
 * - `application/reports+json` (Reporting API): an array of `{type, url, body}`; the CSP ones have
 *   `type: "csp-violation"` and `body.{documentURL, blockedURL, effectiveDirective, ...}`.
 * Anything else is refused with 415 and nothing is logged.
 *
 * WHAT IS LOGGED, AND WHAT IS NOT. One line per violation: the directive, the blocked resource's
 * host (or its keyword or scheme, e.g. `inline`, `data`), and the page's path. Never the raw body,
 * never a full URL, never a query string or fragment: a report carries the page URL the visitor was
 * on (which can hold an address or a token in its query) and, for inline violations, a sample of
 * the offending script. Every logged field is reduced to a fixed character set so a report cannot
 * write a second log line.
 *
 * LIMITS. The body is read up to 16 KB and refused with 413 past that, whatever Content-Length
 * says. At most 20 violations are logged from one request. The answer is always an empty 204 for a
 * report the route accepted, so the browser has nothing to retry.
 *
 * RATE LIMIT. The per-request cap alone let a flood write 20 log lines per
 * request without end. Log lines now come from ONE token bucket shared by every caller: LOG_BURST lines at once,
 * refilled at LOG_REFILL_PER_SECOND. It is global on purpose, not per IP: the only client address this route sees is
 * a forwarded header the sender chooses, so a per-IP bucket is one a flood sidesteps by rotating the header. An empty
 * bucket answers 429 before the body is read; a request that arrives with fewer tokens than violations logs only as
 * many as there are tokens. The bucket lives in this server instance's memory: each instance bounds its own log.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPORTS_PER_REQUEST = 20;
const MAX_PATH_CHARS = 200;
const LOG_BURST = 100;
const LOG_REFILL_PER_SECOND = 1;

let logTokens = LOG_BURST;
let logRefilledAt = Date.now();

function refillLogTokens(): void {
  const now = Date.now();
  logTokens = Math.min(LOG_BURST, logTokens + ((now - logRefilledAt) / 1000) * LOG_REFILL_PER_SECOND);
  logRefilledAt = now;
}

/** Takes up to `want` whole log tokens and returns how many it took. */
function takeLogTokens(want: number): number {
  refillLogTokens();
  const got = Math.max(0, Math.min(want, Math.floor(logTokens)));
  logTokens -= got;
  return got;
}

/** Tests only: a full bucket at the current (possibly faked) time. */
export function resetCspReportBudget(): void {
  logTokens = LOG_BURST;
  logRefilledAt = Date.now();
}

const CSP_REPORT = "application/csp-report";
const REPORTS_JSON = "application/reports+json";

type Violation = { directive: string; blocked: string; path: string };

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body up to MAX_BODY_BYTES, or null when it is larger. Counts the bytes actually read. */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** `script-src-elem`; CSP2's violated-directive carries the sources after it, which are dropped. */
function directiveOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const name = value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[a-z-]{1,40}$/.test(name) ? name : "unknown";
}

/** Host (with port) of a blocked URL, its scheme for a non-network URL, or the CSP keyword. */
function blockedOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "none";
  const raw = value.trim();
  if (/^[a-z][a-z-]{0,39}$/i.test(raw)) return raw.toLowerCase();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "unknown";
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss") {
    const host = url.host.toLowerCase();
    return /^[a-z0-9.:[\]-]{1,255}$/.test(host) ? host : "unknown";
  }
  return /^[a-z][a-z0-9+.-]{0,39}$/.test(scheme) ? scheme : "unknown";
}

/** The page's path alone: no origin, no query string, no fragment. */
function pathOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "unknown";
  }
  const path = url.pathname.slice(0, MAX_PATH_CHARS);
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path) ? path : "unknown";
}

function fromCspReport(payload: unknown): Violation[] | null {
  const report = isRecord(payload) ? payload["csp-report"] : undefined;
  if (!isRecord(report)) return null;
  return [{
    directive: directiveOf(report["effective-directive"] ?? report["violated-directive"]),
    blocked: blockedOf(report["blocked-uri"]),
    path: pathOf(report["document-uri"]),
  }];
}

function fromReportsJson(payload: unknown): Violation[] | null {
  if (!Array.isArray(payload)) return null;
  const violations: Violation[] = [];
  for (const entry of payload) {
    if (!isRecord(entry) || entry.type !== "csp-violation" || !isRecord(entry.body)) continue;
    const body = entry.body;
    violations.push({
      directive: directiveOf(body.effectiveDirective),
      blocked: blockedOf(body.blockedURL),
      path: pathOf(body.documentURL ?? entry.url),
    });
  }
  return violations;
}

export async function POST(request: Request): Promise<Response> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== CSP_REPORT && type !== REPORTS_JSON) return empty(415);

  refillLogTokens();
  if (logTokens < 1) return empty(429, { "retry-after": String(Math.ceil(1 / LOG_REFILL_PER_SECOND)) });

  const bytes = await readCapped(request);
  if (bytes === null) return empty(413);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return empty(400);
  }

  const violations = type === CSP_REPORT ? fromCspReport(payload) : fromReportsJson(payload);
  if (violations === null) return empty(400);

  const logged = violations.slice(0, MAX_REPORTS_PER_REQUEST);
  for (const { directive, blocked, path } of logged.slice(0, takeLogTokens(logged.length))) {
    console.warn(`csp-report directive=${directive} blocked=${blocked} path=${path}`);
  }
  return empty(204);
}

/** Reports are only ever POSTed; every other method is refused rather than left to a default. */
function methodNotAllowed(): Response {
  return empty(405, { allow: "POST" });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
