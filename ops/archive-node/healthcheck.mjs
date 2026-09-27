#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/archive-node/healthcheck.mjs — is our chain-4663 archive node at the tip, and is it an ARCHIVE?
 *
 *   NODE_RPC_URL=http://archive-4663.railway.internal:8547 node ops/archive-node/healthcheck.mjs
 *
 * Two questions, both answered against the node's own JSON-RPC:
 *
 *   1. LAG. Our head vs a reference head. The reference defaults to the public RPC, which is fine
 *      for a head read; it is never used as an archive source (it refuses historical state,
 *      as the deploy notes say). Lag is reported in blocks and in seconds at the chain's own rate,
 *      measured from the two heads' timestamps rather than assumed.
 *   2. ARCHIVE. eth_getBalance at a deep historical block. A full (pruned) node answers
 *      "historical state ... is not available"; an archive answers a number. Without this probe a
 *      pruned node at the tip would report healthy, which is exactly the false green that would
 *      send the indexer's historical eth_call to a node that cannot serve it.
 *
 * Exit 0 = ok, 1 = warn or fail (one JSON line on stdout either way), 2 = usage error.
 *
 *   node ops/archive-node/healthcheck.mjs --serve 9547
 *
 * serves the same verdict as GET /health, shaped for ops/v2/monitor.mjs `--health`: ok -> 200
 * {"status":"ok"}, warn -> 200 {"status":"lagging"} (the monitor's v2_mon_service_degraded), fail -> 503
 * (v2_mon_service_down). So the monitor pages on this node with
 * `--health archive-4663=http://<host>:9547/health` and no change to monitor.mjs. The verdict is cached
 * for SERVE_CACHE_MS (default 5000) so a scraper cannot turn this into load on the node.
 *
 * No dependencies: node >= 22 fetch only. Nothing here writes anywhere.
 * ------------------------------------------------------------------------------------------------- */

export const DEFAULTS = Object.freeze({
  referenceUrl: "https://rpc.mainnet.chain.robinhood.com",
  // Chain 4663 produces ~9.9 blocks/s. 600 blocks is
  // about a minute: normal jitter between two nodes is a handful of blocks.
  warnLagBlocks: 600,
  // ~10 minutes behind. The indexer's own lag alarm (v2_mon_l2_lag, lagErrorS 900) sits above this,
  // so the node pages before the indexer does.
  failLagBlocks: 6000,
  // A block old enough that no pruned node still holds its state, and that exists on 4663. Block 1
  // is the first post-genesis block; the public (non-archive) RPC refuses it.
  archiveProbeBlock: 1,
  // An address whose balance query is cheap and exists at every height.
  archiveProbeAddress: "0x0000000000000000000000000000000000000000",
  timeoutMs: 10_000,
});

/**
 * Pure lag verdict. Heads are block numbers (bigint or number), timestamps are unix seconds.
 * A node AHEAD of the reference (it happens: the reference can lag too) is not lag.
 * @returns {{status: "ok"|"warn"|"fail", lagBlocks: number, lagSeconds: number|null, reason: string}}
 */
export function assessLag({ ownHead, refHead, ownTimestamp, refTimestamp }, t = DEFAULTS) {
  for (const [k, v] of Object.entries({ ownHead, refHead })) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) {
      return { status: "fail", lagBlocks: null, lagSeconds: null, reason: `${k} unreadable` };
    }
  }
  const own = BigInt(ownHead);
  const ref = BigInt(refHead);
  const lagBlocks = own >= ref ? 0 : Number(ref - own);
  // Seconds from the timestamps, not blocks / assumed-rate: a stalled sequencer makes both heads old
  // and equal, and that is the reference's problem, not ours.
  const lagSeconds =
    ownTimestamp != null && refTimestamp != null ? Math.max(0, Number(refTimestamp) - Number(ownTimestamp)) : null;
  if (lagBlocks >= t.failLagBlocks) {
    return { status: "fail", lagBlocks, lagSeconds, reason: `${lagBlocks} blocks behind the reference (fail at ${t.failLagBlocks})` };
  }
  if (lagBlocks >= t.warnLagBlocks) {
    return { status: "warn", lagBlocks, lagSeconds, reason: `${lagBlocks} blocks behind the reference (warn at ${t.warnLagBlocks})` };
  }
  return { status: "ok", lagBlocks, lagSeconds, reason: own > ref ? "ahead of the reference" : "at the tip" };
}

/**
 * Pure archive verdict from the probe's raw outcome.
 * @param {{result?: string, error?: {message?: string}|string}} probe
 */
export function assessArchive(probe) {
  if (probe && typeof probe.result === "string" && /^0x[0-9a-fA-F]*$/.test(probe.result)) {
    return { status: "ok", reason: "historical state served" };
  }
  const msg = typeof probe?.error === "string" ? probe.error : probe?.error?.message ?? "no result";
  if (/historical state|missing trie node|state .* not available|header not found/i.test(msg)) {
    return { status: "fail", reason: `NOT AN ARCHIVE: ${msg}` };
  }
  return { status: "fail", reason: `archive probe failed: ${msg}` };
}

/** Worst of several statuses. */
export function worst(...statuses) {
  const rank = { ok: 0, warn: 1, fail: 2 };
  return statuses.reduce((a, b) => (rank[b] > rank[a] ? b : a), "ok");
}

/** Strips credentials and path/query from a URL so it can be printed. Keyed URLs never reach stdout. */
export function hostOnly(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<unparseable url>";
  }
}

async function rpc(url, method, params, timeoutMs) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: `HTTP ${res.status}, non-JSON body` };
  }
  return body;
}

async function head(url, timeoutMs) {
  const b = await rpc(url, "eth_getBlockByNumber", ["latest", false], timeoutMs);
  if (!b.result) throw new Error(typeof b.error === "string" ? b.error : b.error?.message ?? "no block");
  return { number: BigInt(b.result.number), timestamp: Number(BigInt(b.result.timestamp)) };
}

export async function run(env = process.env, t = DEFAULTS) {
  const nodeUrl = env.NODE_RPC_URL;
  if (!nodeUrl) return { code: 2, report: { status: "fail", reason: "NODE_RPC_URL is required" } };
  const refUrl = env.REFERENCE_RPC_URL || t.referenceUrl;
  const th = {
    ...t,
    warnLagBlocks: Number(env.WARN_LAG_BLOCKS ?? t.warnLagBlocks),
    failLagBlocks: Number(env.FAIL_LAG_BLOCKS ?? t.failLagBlocks),
    archiveProbeBlock: Number(env.ARCHIVE_PROBE_BLOCK ?? t.archiveProbeBlock),
  };

  let own = null;
  let ref = null;
  const errors = {};
  await Promise.all([
    head(nodeUrl, th.timeoutMs).then((h) => (own = h), (e) => (errors.node = String(e.message ?? e))),
    head(refUrl, th.timeoutMs).then((h) => (ref = h), (e) => (errors.reference = String(e.message ?? e))),
  ]);

  let lag;
  if (!own) lag = { status: "fail", lagBlocks: null, lagSeconds: null, reason: `node head unreadable: ${errors.node}` };
  else if (!ref) lag = { status: "warn", lagBlocks: null, lagSeconds: null, reason: `reference head unreadable: ${errors.reference}` };
  else lag = assessLag({ ownHead: own.number, refHead: ref.number, ownTimestamp: own.timestamp, refTimestamp: ref.timestamp }, th);

  let archive;
  try {
    const probe = await rpc(nodeUrl, "eth_getBalance", [th.archiveProbeAddress, "0x" + th.archiveProbeBlock.toString(16)], th.timeoutMs);
    archive = assessArchive(probe);
  } catch (e) {
    archive = assessArchive({ error: String(e.message ?? e) });
  }

  const status = worst(lag.status, archive.status);
  return {
    code: status === "ok" ? 0 : 1,
    report: {
      status,
      node: hostOnly(nodeUrl),
      reference: hostOnly(refUrl),
      ownHead: own ? own.number.toString() : null,
      refHead: ref ? ref.number.toString() : null,
      lag,
      archive: { probeBlock: th.archiveProbeBlock, ...archive },
    },
  };
}

/** The /health answer for a run() result, in the shape monitor.mjs checkHealth reads. */
export function healthResponse({ code, report }) {
  if (code === 2 || report.status === "fail") return { httpStatus: 503, body: { ...report, status: "fail" } };
  if (report.status === "warn") return { httpStatus: 200, body: { ...report, status: "lagging" } };
  return { httpStatus: 200, body: report };
}

/** An HTTP server answering GET /health with a cached verdict. Returns the node:http server (not listening). */
export async function createHealthServer(env = process.env, t = DEFAULTS, runImpl = run) {
  const { createServer } = await import("node:http");
  const cacheMs = Number(env.SERVE_CACHE_MS ?? 5000);
  let cached = null;
  let cachedAt = 0;
  let inflight = null;
  const verdict = async () => {
    if (cached && Date.now() - cachedAt < cacheMs) return cached;
    // One run at a time; a rejected run clears the slot so the next request retries instead of
    // replaying the rejection forever.
    inflight ??= runImpl(env, t)
      .then((r) => {
        cached = healthResponse(r);
        cachedAt = Date.now();
        return cached;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return createServer(async (req, res) => {
    if (req.method !== "GET" || req.url.split("?")[0] !== "/health") {
      res.writeHead(404).end();
      return;
    }
    let out;
    try {
      out = await verdict();
    } catch (e) {
      out = { httpStatus: 503, body: { status: "fail", reason: `health check threw: ${String(e?.message ?? e)}` } };
    }
    res.writeHead(out.httpStatus, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--serve");
  if (i !== -1) {
    const port = Number(process.argv[i + 1]);
    if (!Number.isInteger(port) || port <= 0) {
      console.error("usage: healthcheck.mjs [--serve PORT]");
      process.exit(2);
    }
    if (!process.env.NODE_RPC_URL) {
      console.error("NODE_RPC_URL is required");
      process.exit(2);
    }
    const server = await createHealthServer();
    server.listen(port, "::", () => console.log(`archive health on :${port}/health`));
  } else {
    const { code, report } = await run();
    console.log(JSON.stringify(report));
    process.exit(code);
  }
}
