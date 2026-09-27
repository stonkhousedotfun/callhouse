/** POST /api/csp-report: both report formats, the size cap, the method and type refusals, and redaction. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { DELETE, GET, PATCH, POST, PUT, resetCspReportBudget } from "./route";

const URL_BASE = "http://localhost/api/csp-report";
const CAP = 16 * 1024;

function post(contentType: string, body: string): Request {
  return new Request(URL_BASE, { method: "POST", headers: { "content-type": contentType }, body });
}

/** A report-uri body carrying every field that must NOT reach the log. */
const LEGACY = {
  "csp-report": {
    "document-uri": "https://app.stonkhouse.fun/portfolio?address=0xabc0000000000000000000000000000000000def#tab=history",
    "referrer": "https://ref.example/?utm=leak",
    "violated-directive": "script-src-elem 'self' 'unsafe-inline'",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; report-uri /api/csp-report",
    "blocked-uri": "https://user:pw@evil.example:8443/x.js?token=sekrit#frag",
    "source-file": "https://app.stonkhouse.fun/_next/static/chunk.js?v=sekrit",
    "script-sample": "sekrit sample",
    "status-code": 200,
  },
};

/** A Reporting API batch: two CSP violations and one report of another type. */
const BATCH = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://app.stonkhouse.fun/trade/nvda?ref=sekrit",
    user_agent: "test",
    body: {
      documentURL: "https://app.stonkhouse.fun/trade/nvda?ref=sekrit",
      blockedURL: "inline",
      effectiveDirective: "style-src-elem",
      disposition: "report",
      sample: "sekrit sample",
    },
  },
  {
    type: "csp-violation",
    url: "https://app.stonkhouse.fun/lend",
    body: {
      documentURL: "https://app.stonkhouse.fun/lend",
      blockedURL: "wss://relay.example.org/socket?key=sekrit",
      effectiveDirective: "connect-src",
      disposition: "report",
    },
  },
  { type: "deprecation", url: "https://app.stonkhouse.fun/", body: { id: "x", message: "sekrit" } },
];

describe("POST /api/csp-report", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => { resetCspReportBudget(); warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  const lines = () => warn.mock.calls.map((call) => call.map(String).join(" "));

  it("accepts a report-uri body (application/csp-report) and logs one redacted line", async () => {
    const res = await POST(post("application/csp-report", JSON.stringify(LEGACY)));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(lines()).toEqual(["csp-report directive=script-src-elem blocked=evil.example:8443 path=/portfolio"]);
  });

  it("accepts a Reporting API batch (application/reports+json) and logs only its CSP violations", async () => {
    const res = await POST(post("application/reports+json; charset=utf-8", JSON.stringify(BATCH)));
    expect(res.status).toBe(204);
    expect(lines()).toEqual([
      "csp-report directive=style-src-elem blocked=inline path=/trade/nvda",
      "csp-report directive=connect-src blocked=relay.example.org path=/lend",
    ]);
  });

  it("never logs a query string, fragment, full URL, credential, sample or other raw field", async () => {
    await POST(post("application/csp-report", JSON.stringify(LEGACY)));
    await POST(post("application/reports+json", JSON.stringify(BATCH)));
    const logged = lines().join("\n");
    expect(warn).toHaveBeenCalledTimes(3);
    for (const leak of ["sekrit", "?", "#", "address=", "0xabc", "://", "user", "pw@", "utm", "original-policy", "default-src", "stonkhouse.fun"]) {
      expect(logged, `log leaked ${JSON.stringify(leak)}`).not.toContain(leak);
    }
  });

  it("reduces odd values to a keyword, a scheme or unknown instead of logging them", async () => {
    const report = (fields: Record<string, unknown>) =>
      post("application/csp-report", JSON.stringify({ "csp-report": fields }));
    await POST(report({ "violated-directive": "img-src", "blocked-uri": "data:image/png;base64,c2Vrcml0", "document-uri": "https://a.example/x" }));
    await POST(report({ "violated-directive": "script-src\nFAKE line", "blocked-uri": "chrome-extension://abcdef/inject.js", "document-uri": "not a url" }));
    await POST(report({ "effective-directive": 42, "blocked-uri": "", "document-uri": "https://a.example/%0A?x=1" }));
    expect(lines()).toEqual([
      "csp-report directive=img-src blocked=data path=/x",
      "csp-report directive=script-src blocked=chrome-extension path=unknown",
      "csp-report directive=unknown blocked=none path=/%0A",
    ]);
    for (const line of lines()) expect(line).not.toMatch(/[\r\n]/);
  });

  it("accepts a body of exactly 16 KB and refuses one byte more with 413, logging nothing", async () => {
    const pad = (size: number) => {
      const base = JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "data", "document-uri": "https://a.example/", pad: "" } });
      return base.replace('"pad":""', `"pad":"${"x".repeat(size - base.length)}"`);
    };
    const atCap = pad(CAP);
    expect(new TextEncoder().encode(atCap).byteLength).toBe(CAP);
    expect((await POST(post("application/csp-report", atCap))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);

    const over = pad(CAP + 1);
    expect(new TextEncoder().encode(over).byteLength).toBe(CAP + 1);
    expect((await POST(post("application/csp-report", over))).status).toBe(413);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a body whose declared Content-Length is over the cap before reading it", async () => {
    const req = new Request(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/csp-report", "content-length": String(CAP + 1) },
      body: JSON.stringify(LEGACY),
    });
    expect((await POST(req)).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs at most 20 violations from one request", async () => {
    const many = Array.from({ length: 50 }, () => BATCH[1]);
    expect((await POST(post("application/reports+json", JSON.stringify(many)))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(20);
  });

  it("refuses any other content type with 415", async () => {
    for (const type of ["application/json", "text/plain", ""]) {
      const res = await POST(post(type, JSON.stringify(LEGACY)));
      expect(res.status, type).toBe(415);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON and a body of the wrong shape with 400", async () => {
    expect((await POST(post("application/csp-report", "{not json"))).status).toBe(400);
    expect((await POST(post("application/csp-report", JSON.stringify(BATCH)))).status).toBe(400);
    expect((await POST(post("application/reports+json", JSON.stringify(LEGACY)))).status).toBe(400);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses every other method with 405 and Allow: POST", async () => {
    for (const handler of [GET, PUT, PATCH, DELETE]) {
      const res = handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The per-request cap of 20 lines did not bound a flood. Log lines now come from one
 * global token bucket (100 at once, 1 per second back). An empty bucket answers 429 before reading the body.
 */
describe("POST /api/csp-report rate limit", () => {
  let warn: MockInstance<typeof console.warn>;
  const batch = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({
    type: "csp-violation", url: `https://app.stonkhouse.fun/p${i}`,
    body: { documentURL: `https://app.stonkhouse.fun/p${i}`, blockedURL: "inline", effectiveDirective: "script-src-elem" },
  })));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    resetCspReportBudget();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

  it("a flood logs at most the burst, then answers 429 with nothing logged", async () => {
    for (let i = 0; i < 5; i += 1) expect((await POST(post("application/reports+json", batch(20)))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(100);
    const refused = await POST(post("application/reports+json", batch(20)));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(warn).toHaveBeenCalledTimes(100);
  });

  it("the bucket refills with time, and a request larger than what is left logs only what is left", async () => {
    for (let i = 0; i < 5; i += 1) await POST(post("application/reports+json", batch(20)));
    vi.advanceTimersByTime(7_000);
    warn.mockClear();
    expect((await POST(post("application/reports+json", batch(20)))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(7);
    expect((await POST(post("application/reports+json", batch(1)))).status).toBe(429);
  });

  it("the type check still comes first: a wrong type is 415 even with the bucket empty", async () => {
    for (let i = 0; i < 5; i += 1) await POST(post("application/reports+json", batch(20)));
    expect((await POST(post("text/plain", "{}"))).status).toBe(415);
  });
});
