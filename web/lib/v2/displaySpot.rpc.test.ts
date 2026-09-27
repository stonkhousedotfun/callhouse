/** lib/v2/displaySpot.ts: the server RPC (fetch stubbed) and the client query (react-query stubbed). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn((options: unknown) => options) }));

import { PUBLIC_RPC_URL, serverRpc, useDisplaySpots } from "./displaySpot";

const WORD = `0x${"0".repeat(63)}1`;
const upstream = vi.fn<typeof fetch>();

beforeEach(() => {
  upstream.mockReset();
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const rpcAnswer = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });

describe("serverRpc", () => {
  it("posts one eth_call at latest to the public RPC and returns a word-aligned hex result", async () => {
    vi.stubEnv("CHAIN_RPC_URL", "");
    upstream.mockResolvedValue(rpcAnswer(WORD + "f".repeat(64)));
    expect(await serverRpc("0xfeed", "0x313ce567")).toBe(WORD + "f".repeat(64));
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(PUBLIC_RPC_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0xfeed", data: "0x313ce567" }, "latest"] });
  });

  it("prefers the server-only CHAIN_RPC_URL, trimmed", async () => {
    vi.stubEnv("CHAIN_RPC_URL", "  https://private.rpc/x  ");
    upstream.mockResolvedValue(rpcAnswer(WORD));
    await serverRpc("0xfeed", "0x00");
    expect(upstream.mock.calls[0]![0]).toBe("https://private.rpc/x");
  });

  it.each([
    ["an HTTP error", () => Promise.resolve(rpcAnswer(WORD, 500))],
    ["an empty result", () => Promise.resolve(rpcAnswer("0x"))],
    ["a non-word-aligned result", () => Promise.resolve(rpcAnswer(`${WORD}ab`))],
    ["a non-hex result", () => Promise.resolve(rpcAnswer(`0x${"z".repeat(64)}`))],
    ["a JSON-RPC error with no result", () => Promise.resolve(new Response(JSON.stringify({ error: { code: -32000 } })))],
    ["a numeric result", () => Promise.resolve(rpcAnswer(1))],
    ["invalid JSON", () => Promise.resolve(new Response("oops"))],
    ["a network failure", () => Promise.reject(new Error("ECONNRESET"))],
  ])("returns null on %s", async (_label, answer) => {
    upstream.mockImplementation(answer);
    expect(await serverRpc("0xfeed", "0x00")).toBeNull();
  });
});

type Options = { queryKey: unknown[]; queryFn: () => Promise<Map<string, unknown>>; refetchInterval: number; staleTime: number; retry: number };

describe("useDisplaySpots", () => {
  const useOptions = () => useDisplaySpots() as unknown as Options;

  it("polls the route every 30 s under a stable key, retrying once", () => {
    const o = useOptions();
    expect(o.queryKey).toEqual(["v2", "display-spot"]);
    expect(o.refetchInterval).toBe(30_000);
    expect(o.staleTime).toBe(25_000);
    expect(o.retry).toBe(1);
  });

  it("parses the route's rows and drops malformed ones", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ items: [
      { ticker: "NVDA", raw: "225549701", updatedAt: 1_790_000_000, source: "chainlink" },
      { ticker: "TSLA", raw: "0", updatedAt: 1, source: "api" },
    ] })));
    const spots = await useOptions().queryFn();
    expect(upstream.mock.calls[0]![0]).toBe("/api/v2/spot");
    expect([...spots.entries()]).toEqual([["NVDA", { raw: 225_549_701n, updatedAt: 1_790_000_000, source: "chainlink" }]]);
  });

  it("throws on a non-OK answer so react-query keeps the last data and retries", async () => {
    upstream.mockResolvedValue(new Response("{}", { status: 502 }));
    await expect(useOptions().queryFn()).rejects.toThrow("display spot route answered HTTP 502");
  });
});
