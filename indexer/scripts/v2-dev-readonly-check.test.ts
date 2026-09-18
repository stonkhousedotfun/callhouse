import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDeployedDev, parseOptions, type Options } from "./v2-dev-readonly-check";

const address = (digit: string) => `0x${digit.repeat(40)}`;
function fixture() {
  const contracts = { clearinghouse: address("1"), orderBook: address("2"), settlementOracle: address("3"),
    expiryCalendar: address("4"), keeperRewards: address("5"), autoRoller: address("6"),
    payoutAdapter: address("7"), makerVault: address("0").replace(/0$/, "4"), makerRegistry: address("8"),
    rewardsDistributor: address("0").replace(/0$/, "5"),
    sources: { chainlink: address("9"), univ3: address("0").replace(/0$/, "6"), dataStreams: address("0").replace(/0$/, "7") } };
  const registry = { shared: { chainId: 4663, usdg: address("0").replace(/0$/, "1") },
    v2: { interfaceVersion: 7, deployBlock: 100, contracts,
      fees: { premiumFeeBps: 0, mintFeePpm: 80, resaleFeeBps: 50, takerFeeFlat: "100000", takerFeeCapBps: 100,
        makerRebateBps: 10, exerciseFeeBps: 25 } },
    markets: [
      { ticker: "NVDA", asset: address("0").replace(/0$/, "2"), v2: { status: "live", puts: false, strikeTick: "1000000" } },
      { ticker: "TSLA", asset: address("0").replace(/0$/, "3"), v2: { status: "planned", puts: true, strikeTick: "1000000" } },
    ],
  };
  const responses: Record<string, unknown> = {
    "/v2/health": { status: "ok", block: "110", lagSeconds: 1, interfaceVersion: 7 },
    "/v2/config": { chainId: 4663, interfaceVersion: 7, deployBlock: "100",
      usdg: { address: registry.shared.usdg, symbol: "USDG", decimals: 6 }, contracts: structuredClone(contracts),
      fees: { ...registry.v2.fees, takerFeeFlat: { raw: registry.v2.fees.takerFeeFlat, decimals: 6, formatted: "0.1" } },
      futureField: "Not part of manifest validation" },
    "/v2/markets": [{ ticker: "NVDA", underlying: registry.markets[0]!.asset, status: "live", puts: false, mintFeePpm: 80,
      strikeTick: { raw: "1000000", decimals: 6, formatted: "1" } }],
  };
  return { registry, responses };
}

describe("read-only deployed-dev manifest checker", () => {
  let directory: string;
  let server: Server;
  let options: Options;
  let data: ReturnType<typeof fixture>;
  let requests: string[];
  let unavailable: string | undefined;
  let hang: string | undefined;
  let redirect: string | undefined;
  let rawBody: { route: string; value: string } | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "v2-readonly-fixture-"));
    data = fixture();
    requests = [];
    unavailable = hang = redirect = undefined;
    rawBody = undefined;
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === hang) { response.writeHead(200); response.write("{"); return; }
      if (request.url === redirect) { response.writeHead(302, { location: "/redirect-target" }); response.end(); return; }
      if (request.url === unavailable) { response.writeHead(503); response.end("upstream detail must not escape"); return; }
      if (request.url === "/ready") { response.end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(rawBody && rawBody.route === request.url ? rawBody.value : JSON.stringify(data.responses[request.url!]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const listener = server.address();
    if (!listener || typeof listener === "string") throw new Error("Missing fixture port");
    const registryPath = join(directory, "pinned-registry.json");
    writeFileSync(registryPath, JSON.stringify(data.registry));
    options = { baseUrl: `http://127.0.0.1:${listener.port}`, registryPath, allowLoopback: true, timeoutMs: 500 };
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  it("passes a matching manifest using only four GETs, with content pin and pending parity checks", async () => {
    const digest = createHash("sha256").update(JSON.stringify(data.registry)).digest("hex");
    const report = await checkDeployedDev({ ...options, registrySha256: digest });
    expect(report.status).toBe("manifest_passed");
    expect(report.registrySha256).toBe(digest);
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.pendingChecks).toHaveLength(2);
    expect(requests.sort()).toEqual(["GET /ready", "GET /v2/config", "GET /v2/health", "GET /v2/markets"]);
    expect(JSON.stringify(report)).not.toContain(options.baseUrl);
  });

  it.each([
    ["config version", "/v2/config", "interfaceVersion", 6],
    ["health version", "/v2/health", "interfaceVersion", 6],
    ["chain", "/v2/config", "chainId", 1],
    ["deploy block", "/v2/config", "deployBlock", "101"],
    ["old indexed block", "/v2/health", "block", "99"],
    ["unhealthy checkpoint", "/v2/health", "status", "lagging"],
    ["excess lag", "/v2/health", "lagSeconds", 121],
  ])("rejects %s drift", async (_name, route, field, value) => {
    (data.responses[route as string] as Record<string, unknown>)[field as string] = value;
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === route)?.passed).toBe(false);
  });

  it("rejects mismatched core, optional and source addresses", async () => {
    const config = data.responses["/v2/config"] as { contracts: typeof data.registry.v2.contracts };
    config.contracts.clearinghouse = address("4");
    config.contracts.payoutAdapter = address("5");
    config.contracts.sources.chainlink = address("6");
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/config")?.details).toEqual([
      "contracts.clearinghouse differs from registry.", "contracts.payoutAdapter differs from registry.",
      "contracts.sources.chainlink differs from registry.",
    ]);
  });

  it("rejects matching registry and API on an unexpected chain", async () => {
    data.registry.shared.chainId = 1;
    (data.responses["/v2/config"] as Record<string, unknown>).chainId = 1;
    writeFileSync(options.registryPath, JSON.stringify(data.registry));
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(requests).toEqual([]);
    expect(report.checks[0]?.details).toEqual(["Registry chain ID does not match expected chain."]);
  });

  it.each(["premiumFeeBps", "mintFeePpm", "resaleFeeBps", "takerFeeFlat", "takerFeeCapBps", "makerRebateBps", "exerciseFeeBps"])("rejects effective %s fee drift", async (field) => {
    const fees = (data.responses["/v2/config"] as { fees: Record<string, unknown> }).fees;
    fees[field] = field === "takerFeeFlat" ? { raw: "500000", decimals: 6, formatted: "0.5" } : 500;
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/config")?.details).toContain(`fees.${field} differs from registry.`);
  });

  it("rejects a flat fee with wrong decimals", async () => {
    const fees = (data.responses["/v2/config"] as { fees: { takerFeeFlat: { decimals: number } } }).fees;
    fees.takerFeeFlat.decimals = 18;
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/config")?.details).toContain("fees.takerFeeFlat differs from registry.");
  });

  it.each(["missing", "unexpected-live", "wrong-underlying", "paused", "duplicate"])("rejects %s market selection", async (change) => {
    const rows = data.responses["/v2/markets"] as Record<string, unknown>[];
    if (change === "missing") rows.splice(0);
    if (change === "unexpected-live") rows.push({ ...rows[0], ticker: "TSLA", underlying: data.registry.markets[1]!.asset });
    if (change === "wrong-underlying") rows[0]!.underlying = address("7");
    if (change === "paused") rows[0]!.status = "paused";
    if (change === "duplicate") rows.push({ ...rows[0] });
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/markets")?.passed).toBe(false);
  });

  it("does not follow redirects or print upstream response content", async () => {
    unavailable = "/ready";
    redirect = "/v2/config";
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/ready")?.details).toEqual(["HTTP 503."]);
    expect(requests).not.toContain("GET /redirect-target");
    expect(JSON.stringify(report)).not.toContain("upstream detail");
  });

  it("times out even when headers arrive but the body stalls", async () => {
    hang = "/v2/health";
    const start = Date.now();
    const report = await checkDeployedDev({ ...options, timeoutMs: 40 });
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/health")?.details).toEqual(["Request timed out."]);
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  it.each(["not json", "x".repeat(1_048_577)])("rejects invalid or oversized bodies", async (value) => {
    rawBody = { route: "/v2/config", value };
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/config")?.passed).toBe(false);
  });

  it("sanitizes connection failures", async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.filter((check) => !check.passed)).toHaveLength(4);
    expect(JSON.stringify(report)).not.toContain(options.baseUrl);
  });

  it.each([
    { allowLoopback: false },
    { baseUrl: "https://user:secret@example.test" },
    { baseUrl: "https://example.test?key=secret" },
    { baseUrl: "http://example.test" },
    { registrySha256: "0".repeat(64) },
    { expectedInterfaceVersion: 6 },
    { timeoutMs: 100_000 },
  ])("refuses invalid inputs before issuing any requests: %j", async (overrides) => {
    const report = await checkDeployedDev({ ...options, ...overrides });
    expect(report.status).toBe("failed");
    expect(requests).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("refuses an undeployed registry before HTTP requests", async () => {
    writeFileSync(options.registryPath, JSON.stringify({ ...data.registry, v2: { ...data.registry.v2, deployBlock: null } }));
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(requests).toEqual([]);
  });

  it("refuses an incomplete full deployment even if that contract is unused", async () => {
    const registry = structuredClone(data.registry);
    writeFileSync(options.registryPath, JSON.stringify({ ...registry, v2: { ...registry.v2,
      contracts: { ...registry.v2.contracts, sources: { ...registry.v2.contracts.sources, dataStreams: null } } } }));
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(requests).toEqual([]);
  });

  it("rejects an API market serving a different writer rent", async () => {
    (data.responses["/v2/markets"] as { mintFeePpm: number }[])[0]!.mintFeePpm = 300;
    const report = await checkDeployedDev(options);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.name === "/v2/markets")?.details)
      .toContain("Market NVDA writer rent differs from registry.");
  });

  it("uses an explicit market override instead of shared rent", async () => {
    const registry = structuredClone(data.registry);
    Object.assign(registry.markets[0]!.v2, { overrides: { mintFeePpm: 300 } });
    writeFileSync(options.registryPath, JSON.stringify(registry));
    (data.responses["/v2/markets"] as { mintFeePpm: number }[])[0]!.mintFeePpm = 300;
    expect((await checkDeployedDev(options)).status).toBe("manifest_passed");
  });

  it.each(["missing", "zero", "zero-market", "over-ceiling"])("refuses %s effective rent before requests", async (mode) => {
    const registry = structuredClone(data.registry);
    if (mode === "missing") Reflect.deleteProperty(registry.v2.fees, "mintFeePpm");
    if (mode === "zero") registry.v2.fees.mintFeePpm = 0;
    if (mode === "zero-market") Object.assign(registry.markets[0]!.v2, { mintFeePpm: 0 });
    if (mode === "over-ceiling") registry.v2.fees.mintFeePpm = 5_001;
    writeFileSync(options.registryPath, JSON.stringify(registry));
    expect((await checkDeployedDev(options)).status).toBe("failed");
    expect(requests).toEqual([]);
  });
});

describe("read-only checker CLI options", () => {
  it("requires explicit inputs and accepts no unknown or duplicate option", () => {
    expect(() => parseOptions([])).toThrow("Explicit --base-url and --registry");
    expect(() => parseOptions(["--secret", "hidden"])).toThrow("Unknown, duplicate or incomplete");
    expect(() => parseOptions(["--registry", "one", "--registry", "two"])).toThrow("Unknown, duplicate or incomplete");
    expect(parseOptions(["--base-url", "https://dev.example.test", "--registry", "/tmp/dev.json", "--interface-version", "7"]))
      .toMatchObject({ baseUrl: "https://dev.example.test", registryPath: "/tmp/dev.json", expectedInterfaceVersion: 7 });
  });
});
