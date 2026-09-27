/* -------------------------------------------------------------------------------------------------
 * node --test ops/archive-node/healthcheck.test.mjs
 *
 * The lag and archive verdicts at every boundary, and whole runs against local JSON-RPC stand-ins:
 * an archive at the tip, a pruned node at the tip (the false green this script exists to refuse),
 * a lagging archive, a dead node and a dead reference; and the --serve /health shape, fed through
 * ops/v2/monitor.mjs's own checkHealth so a drift in either side goes red here. No network.
 * ------------------------------------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { checkHealth } from "../v2/monitor.mjs";
import { assessArchive, assessLag, createHealthServer, DEFAULTS, healthResponse, hostOnly, run, worst } from "./healthcheck.mjs";

const T = { ...DEFAULTS, warnLagBlocks: 600, failLagBlocks: 6000 };

describe("assessLag", () => {
  test("at the tip is ok", () => {
    const r = assessLag({ ownHead: 70_000_000n, refHead: 70_000_000n, ownTimestamp: 100, refTimestamp: 100 }, T);
    assert.equal(r.status, "ok");
    assert.equal(r.lagBlocks, 0);
    assert.equal(r.lagSeconds, 0);
  });

  test("ahead of the reference is ok and not negative lag", () => {
    const r = assessLag({ ownHead: 70_000_010n, refHead: 70_000_000n, ownTimestamp: 101, refTimestamp: 100 }, T);
    assert.equal(r.status, "ok");
    assert.equal(r.lagBlocks, 0);
    assert.equal(r.lagSeconds, 0);
    assert.match(r.reason, /ahead/);
  });

  test("one block under the warn threshold is ok, at it is warn", () => {
    assert.equal(assessLag({ ownHead: 1000n - 599n, refHead: 1000n }, T).status, "ok");
    const w = assessLag({ ownHead: 1000n - 600n, refHead: 1000n }, T);
    assert.equal(w.status, "warn");
    assert.equal(w.lagBlocks, 600);
  });

  test("one block under the fail threshold is warn, at it is fail", () => {
    assert.equal(assessLag({ ownHead: 10_000n - 5_999n, refHead: 10_000n }, T).status, "warn");
    const f = assessLag({ ownHead: 10_000n - 6_000n, refHead: 10_000n }, T);
    assert.equal(f.status, "fail");
    assert.equal(f.lagBlocks, 6000);
  });

  test("the incident that motivated this: 213k blocks behind is fail", () => {
    const r = assessLag({ ownHead: 69_946_316, refHead: 70_159_054, ownTimestamp: 1790088186, refTimestamp: 1790109591 }, T);
    assert.equal(r.status, "fail");
    assert.equal(r.lagBlocks, 212_738);
    assert.equal(r.lagSeconds, 21_405);
  });

  test("seconds come from timestamps, and are null when a timestamp is missing", () => {
    assert.equal(assessLag({ ownHead: 1n, refHead: 11n, ownTimestamp: 50, refTimestamp: 51 }, T).lagSeconds, 1);
    assert.equal(assessLag({ ownHead: 1n, refHead: 11n }, T).lagSeconds, null);
  });

  test("numbers and hex-free strings are accepted as heads", () => {
    assert.equal(assessLag({ ownHead: "100", refHead: 700 }, T).status, "warn");
  });

  test("an unreadable head is fail, never ok", () => {
    assert.equal(assessLag({ ownHead: null, refHead: 1n }, T).status, "fail");
    assert.equal(assessLag({ ownHead: 1n, refHead: undefined }, T).status, "fail");
    assert.equal(assessLag({ ownHead: "garbage", refHead: 1n }, T).status, "fail");
  });

  test("thresholds are honoured, not hard-coded", () => {
    const tight = { ...T, warnLagBlocks: 1, failLagBlocks: 2 };
    assert.equal(assessLag({ ownHead: 9n, refHead: 10n }, tight).status, "warn");
    assert.equal(assessLag({ ownHead: 8n, refHead: 10n }, tight).status, "fail");
  });
});

describe("assessArchive", () => {
  test("a hex balance is an archive", () => {
    assert.equal(assessArchive({ result: "0x0" }).status, "ok");
    assert.equal(assessArchive({ result: "0x1bc16d674ec80000" }).status, "ok");
  });

  test("the exact refusal the public 4663 RPC returns is NOT AN ARCHIVE", () => {
    // Quoted from rpc.mainnet.chain.robinhood.com, 2026-09-23.
    const r = assessArchive({
      error: { code: -32000, message: "historical state e49be5b12ed2a52a69d7d5967651604638f2b3ec4ed43b4470630dc01d476d31 is not available" },
    });
    assert.equal(r.status, "fail");
    assert.match(r.reason, /^NOT AN ARCHIVE/);
  });

  test("geth-style missing trie node is NOT AN ARCHIVE", () => {
    assert.match(assessArchive({ error: { message: "missing trie node abc (path )" } }).reason, /^NOT AN ARCHIVE/);
  });

  test("any other failure is still fail", () => {
    for (const p of [{}, null, { result: null }, { result: "not-hex" }, { error: "fetch failed" }]) {
      assert.equal(assessArchive(p).status, "fail", JSON.stringify(p));
    }
  });
});

test("worst", () => {
  assert.equal(worst("ok", "ok"), "ok");
  assert.equal(worst("ok", "warn"), "warn");
  assert.equal(worst("warn", "fail", "ok"), "fail");
});

test("hostOnly drops keys, paths and credentials", () => {
  assert.equal(hostOnly("https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY"), "https://robinhood-mainnet.g.alchemy.com");
  assert.equal(hostOnly("http://user:pw@archive-4663.railway.internal:8547/?k=1"), "http://archive-4663.railway.internal:8547");
  assert.equal(hostOnly("not a url"), "<unparseable url>");
});

/* ---------------------------------------------------------------------------------------------- */
/*  whole runs against local stand-ins                                                             */
/* ---------------------------------------------------------------------------------------------- */

function stub({ head, ts = 1790130000, archive = true }) {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      let out;
      if (method === "eth_getBlockByNumber") {
        out = { result: { number: "0x" + head.toString(16), timestamp: "0x" + ts.toString(16) } };
      } else if (method === "eth_getBalance") {
        const at = BigInt(params[1]);
        out = archive || at >= BigInt(head) - 128n
          ? { result: "0x0" }
          : { error: { code: -32000, message: "historical state deadbeef is not available" } };
      } else out = { error: { code: -32601, message: "method not found" } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...out }));
    });
  });
}

const servers = {};
async function listen(name, s) {
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers[name] = { s, url: `http://127.0.0.1:${s.address().port}` };
}

describe("run", () => {
  before(async () => {
    await listen("ref", stub({ head: 70_000_000, ts: 1790130000 }));
    await listen("archiveTip", stub({ head: 70_000_000, ts: 1790130000 }));
    await listen("prunedTip", stub({ head: 70_000_000, ts: 1790130000, archive: false }));
    await listen("archiveBehind", stub({ head: 70_000_000 - 7000, ts: 1790130000 - 707 }));
    await listen("archiveSlightlyBehind", stub({ head: 70_000_000 - 700, ts: 1790130000 - 70 }));
  });
  after(() => Object.values(servers).forEach(({ s }) => s.close()));

  const env = (node, ref = servers.ref.url) => ({ NODE_RPC_URL: node, REFERENCE_RPC_URL: ref });

  test("archive at the tip: exit 0", async () => {
    const { code, report } = await run(env(servers.archiveTip.url));
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(report.status, "ok");
    assert.equal(report.lag.lagBlocks, 0);
    assert.equal(report.archive.status, "ok");
  });

  test("PRUNED node at the tip is refused: the false green this script exists for", async () => {
    const { code, report } = await run(env(servers.prunedTip.url));
    assert.equal(code, 1);
    assert.equal(report.status, "fail");
    assert.equal(report.lag.status, "ok", "the lag half alone would have said healthy");
    assert.match(report.archive.reason, /^NOT AN ARCHIVE/);
  });

  test("700 blocks behind: warn, exit 1", async () => {
    const { code, report } = await run(env(servers.archiveSlightlyBehind.url));
    assert.equal(code, 1);
    assert.equal(report.status, "warn");
    assert.equal(report.lag.lagBlocks, 700);
    assert.equal(report.lag.lagSeconds, 70);
  });

  test("7000 blocks behind: fail", async () => {
    const { report } = await run(env(servers.archiveBehind.url));
    assert.equal(report.status, "fail");
    assert.equal(report.lag.lagBlocks, 7000);
  });

  test("threshold env overrides are read", async () => {
    const { report } = await run({ ...env(servers.archiveSlightlyBehind.url), WARN_LAG_BLOCKS: "800", FAIL_LAG_BLOCKS: "900" });
    assert.equal(report.status, "ok");
  });

  test("dead node: fail, and the report never prints a path or key", async () => {
    const { code, report } = await run(env("http://127.0.0.1:1/v2/SECRETKEY"));
    assert.equal(code, 1);
    assert.equal(report.status, "fail");
    assert.match(report.lag.reason, /node head unreadable/);
    assert.doesNotMatch(JSON.stringify(report), /SECRETKEY/);
  });

  test("dead reference with a healthy archive: warn, not ok and not fail", async () => {
    const { report } = await run(env(servers.archiveTip.url, "http://127.0.0.1:1"));
    assert.equal(report.status, "warn");
    assert.match(report.lag.reason, /reference head unreadable/);
    assert.equal(report.archive.status, "ok");
  });

  test("no NODE_RPC_URL: usage error, exit 2", async () => {
    const { code } = await run({});
    assert.equal(code, 2);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/*  --serve: the /health shape ops/v2/monitor.mjs reads                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("healthResponse maps onto monitor.mjs checkHealth", () => {
  const monitorSees = (r) => {
    const h = healthResponse(r);
    return checkHealth({ name: "archive-4663", url: "http://x/health", reachable: true, httpStatus: h.httpStatus, body: h.body, error: null });
  };

  test("ok -> no finding", () => {
    assert.deepEqual(monitorSees({ code: 0, report: { status: "ok" } }), []);
  });

  test("warn (lagging) -> v2_mon_service_degraded", () => {
    const f = monitorSees({ code: 1, report: { status: "warn" } });
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "v2_mon_service_degraded");
  });

  test("fail (not an archive, far behind, node down) -> v2_mon_service_down", () => {
    const f = monitorSees({ code: 1, report: { status: "fail" } });
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "v2_mon_service_down");
  });

  test("usage error (no NODE_RPC_URL) is never served as healthy", () => {
    assert.equal(healthResponse({ code: 2, report: { status: "fail" } }).httpStatus, 503);
  });
});

describe("createHealthServer", () => {
  const get = async (server, p = "/health") => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
      return { status: res.status, body: res.status === 404 ? null : await res.json() };
    } finally {
      server.close();
    }
  };

  test("serves the verdict and caches it", async () => {
    let calls = 0;
    const fake = async () => (calls++, { code: 1, report: { status: "warn", lag: { lagBlocks: 700 } } });
    const server = await createHealthServer({ SERVE_CACHE_MS: "60000" }, DEFAULTS, fake);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/health`;
    try {
      const a = await fetch(url);
      const b = await fetch(url);
      assert.equal(a.status, 200);
      assert.equal((await a.json()).status, "lagging");
      assert.equal((await b.json()).lag.lagBlocks, 700);
      assert.equal(calls, 1, "second request within the cache window must not re-probe the node");
    } finally {
      server.close();
    }
  });

  test("a throwing run is a 503, and the next request retries", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { code: 0, report: { status: "ok" } };
    };
    const server = await createHealthServer({ SERVE_CACHE_MS: "0" }, DEFAULTS, flaky);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/health`;
    try {
      const a = await fetch(url);
      assert.equal(a.status, 503);
      assert.match((await a.json()).reason, /boom/);
      const b = await fetch(url);
      assert.equal(b.status, 200);
      assert.equal(calls, 2);
    } finally {
      server.close();
    }
  });

  test("anything but GET /health is 404", async () => {
    const server = await createHealthServer({}, DEFAULTS, async () => ({ code: 0, report: { status: "ok" } }));
    assert.equal((await get(server, "/")).status, 404);
  });
});
