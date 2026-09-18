#!/usr/bin/env node
/**
 * serve-v2 — the indexer API v2 as static files, for building the dapp and the site before the
 * devnet (F2-04) exists.
 *
 *   node ops/fixtures/serve-v2.mjs                 # http://localhost:42070/v2/health
 *   node ops/fixtures/serve-v2.mjs --port 4000     # or PORT=4000; --port 0 picks a free port
 *   NEXT_PUBLIC_API_URL=http://localhost:42070 pnpm --filter @callhouse/web dev
 *
 * GET /v2/<path> answers with ops/fixtures/api/v2/<path>.json, byte for byte, re-read on every
 * request so `node ops/fixtures/api/v2/gen.mjs` shows up without a restart. The query string is
 * ignored: every file is one example response (the route's defaults), so `?cursor=` returns the
 * same page — which is why every fixture list ends with `nextCursor: null`, or a pager pointed
 * here would loop forever. Path segments match case-insensitively when there is no exact hit, so
 * a lowercase address or ticker still finds its checksummed/upper-case file, as the real
 * indexer's lookups would.
 *
 * Headers and errors mirror indexer/src/api/v2/: `Cache-Control: no-store` on
 * /v2/health and /v2/config, and `max-age=15` elsewhere; CORS `*` with an OPTIONS preflight, because the dapp on
 * :3000 calls this from the browser; an unknown route or id is 404 and any method other than GET
 * (and the preflight) is 405, both as `{ error: { code, message } }`.
 *
 * DELIBERATELY ABSENT: dependencies (node:http only, runnable before `pnpm install`), exports,
 * routing tables (the directory layout IS the route table; web/lib/v2/api-schema.test.ts proves
 * every file maps to a §4 route) and any serving outside ops/fixtures/api/v2.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "api", "v2");
const DEFAULT_PORT = 42070;

function parsePort(argv, env) {
  const i = argv.findIndex((a) => a === "--port" || a.startsWith("--port="));
  const raw = i === -1 ? env.PORT : argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`serve-v2: bad port ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return port;
}

/** One path segment: letters, digits, `-`, `_` and `.`, but never `.` or `..` on its own. */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Resolves `/v2/a/b/c` to ROOT/a/b/c.json one segment at a time, exact name first, then a
 * case-insensitive match among that directory's entries. Returns null for anything unsafe or
 * absent. Walking real directory entries (rather than joining the raw path) is also what keeps
 * a request from escaping ROOT.
 */
function resolveFixture(pathname) {
  if (!pathname.startsWith("/v2/")) return null;
  let segments;
  try {
    segments = pathname.slice(4).replace(/\/+$/, "").split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length === 0 || segments.some((s) => !SEGMENT_RE.test(s) || s === "." || s === "..")) return null;
  let dir = ROOT;
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const want = last ? `${segments[i]}.json` : segments[i];
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    const hit = entries.includes(want) ? want : entries.find((e) => e.toLowerCase() === want.toLowerCase());
    if (!hit) return null;
    const next = join(dir, hit);
    let st;
    try {
      st = statSync(next);
    } catch {
      return null;
    }
    if (last ? !st.isFile() : !st.isDirectory()) return null;
    dir = next;
  }
  return dir;
}

function send(res, status, body, extra = {}) {
  const text = typeof body === "string" ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  });
  res.end(text);
}

const errorBody = (code, message) => ({ error: { code, message } });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixtures.local");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "*",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }
  if (req.method !== "GET") {
    send(res, 405, errorBody("method_not_allowed", `${req.method} is not supported; the v2 API is GET only`), {
      Allow: "GET, OPTIONS",
      "Cache-Control": "no-store",
    });
    return;
  }
  const file = resolveFixture(url.pathname);
  if (!file) {
    send(res, 404, errorBody("not_found", `no fixture for ${url.pathname}`), { "Cache-Control": "no-store" });
    return;
  }
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    send(res, 404, errorBody("not_found", `no fixture for ${url.pathname}`), { "Cache-Control": "no-store" });
    return;
  }
  const cache = file === join(ROOT, "health.json") || file === join(ROOT, "config.json")
    ? "no-store" : "public, max-age=15";
  send(res, 200, body, { "Cache-Control": cache });
});

server.listen(parsePort(process.argv.slice(2), process.env), () => {
  const { port } = server.address();
  console.log(`serve-v2: ops/fixtures/api/v2 at http://localhost:${port}/v2 (try /v2/health)`);
});

// Stop cleanly on Ctrl-C or a supervisor's TERM; open keep-alive sockets must not hold the process.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
