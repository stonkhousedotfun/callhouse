import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { cache15s, clearCache, responseCacheKey, v2QueryKeys } from "./cache";
import { ROUTES } from "./v2/schema";

const ALICE = `0x${"a".repeat(40)}`;
const BOB = `0x${"b".repeat(40)}`;

beforeEach(clearCache);

describe("public response cache keys", () => {
  it("keeps every handler query key in that route's cache-key allowlist", () => {
    const directory = join(import.meta.dirname, "v2");
    const handlers = readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const source = readFileSync(join(directory, file), "utf8");
        const registrations = [...source.matchAll(/\b(?:app|v2App)\.get\(\s*"([^"]+)"/g)];
        return registrations.map((registration, index) => ({
          route: `/v2${registration[1]}`,
          file,
          // Slice at the next registration, not the end of the file. That keeps two routes in
          // one module independent, so a query key read by one cannot satisfy its neighbour.
          handler: source.slice(registration.index!, registrations[index + 1]?.index ?? source.length),
        }));
      });

    for (const { route } of ROUTES) {
      const matches = handlers.filter((handler) => handler.route === route);
      expect(matches, `GET ${route} must have exactly one source handler`).toHaveLength(1);
      const handler = matches[0]!;
      const reads = new Set([...handler.handler.matchAll(/c\.req\.query\("([^"]+)"\)/g)].map((match) => match[1]!));
      const allowlist = v2QueryKeys.find(([pattern]) => pattern.test(route))?.[1];
      // No matching pattern is fail-safe: responseCacheKey keeps the raw URL and over-keys.
      if (allowlist === undefined) continue;
      for (const key of reads) {
        expect(allowlist, `${route} reads query key ${key} in ${handler.file}, but its cache key omits it`).toContain(key);
      }
    }
  });

  it("shares the positions snapshot across ignored query parameters without mixing accounts", async () => {
    let reads = 0;
    const app = new Hono();
    app.use("*", cache15s);
    app.get("/v2/accounts/:address/positions", (c) => c.json({ account: c.req.param("address"), reads: ++reads }));

    const first = await app.request(`http://localhost/v2/accounts/${ALICE}/positions?nonce=1`);
    const second = await app.request(`http://localhost/v2/accounts/${ALICE}/positions?nonce=2`);
    const other = await app.request(`http://localhost/v2/accounts/${BOB}/positions?nonce=2`);

    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.json()).toEqual(await first.json());
    expect(other.headers.get("x-cache")).toBe("MISS");
    expect(reads).toBe(2);
  });

  it("retains real filter and cursor keys and never reuses a valid response for malformed input", async () => {
    let reads = 0;
    const app = new Hono();
    app.use("*", cache15s);
    app.get("/v2/cards", (c) => {
      const type = c.req.query("type");
      if (type !== undefined && type !== "call" && type !== "put")
        return c.json({ error: "bad_type" }, 400);
      return c.json({ type, cursor: c.req.query("cursor"), reads: ++reads });
    });

    const callPage = await app.request("http://localhost/v2/cards?type=call&cursor=0");
    const putPage = await app.request("http://localhost/v2/cards?type=put&cursor=0");
    const nextPage = await app.request("http://localhost/v2/cards?type=call&cursor=1");
    const malformed = await app.request("http://localhost/v2/cards?type=broken&cursor=0");

    expect(callPage.headers.get("x-cache")).toBe("MISS");
    expect(putPage.headers.get("x-cache")).toBe("MISS");
    expect(nextPage.headers.get("x-cache")).toBe("MISS");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("x-cache")).toBeNull();
    expect(reads).toBe(3);
    expect(responseCacheKey(`http://localhost/v2/accounts/${ALICE}/history?cursor=1`))
      .not.toBe(responseCacheKey(`http://localhost/v2/accounts/${ALICE}/history?cursor=2`));
  });

  it("coalesces concurrent expensive reads across ignored query keys", async () => {
    let reads = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const app = new Hono();
    app.use("*", cache15s);
    app.get("/v2/markets/:ticker/series", async (c) => {
      reads++;
      await gate;
      return c.json({ ticker: c.req.param("ticker"), expiry: c.req.query("expiry"), reads });
    });
    const first = app.request("http://localhost/v2/markets/TEST/series?expiry=123&nonce=one");
    const second = app.request("http://localhost/v2/markets/TEST/series?nonce=two&expiry=123");
    await Promise.resolve();
    finish();
    const responses = await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(responses.map((response) => response.headers.get("x-cache"))).toEqual(["MISS", "HIT"]);
    expect(await responses[1]!.json()).toEqual(await responses[0]!.json());
    expect(responseCacheKey("http://localhost/v2/stats?random=1"))
      .toBe(responseCacheKey("http://localhost/v2/stats?random=2"));
    expect(responseCacheKey("http://localhost/v2/cards?type=call&nonce=1"))
      .not.toBe(responseCacheKey("http://localhost/v2/cards?type=put&nonce=2"));
  });

  it("separates admin-operation pages by status and cursor while ignoring unknown keys", () => {
    const pending = responseCacheKey("http://localhost/v2/admin/operations?status=pending&cursor=one&limit=20&nonce=1");
    expect(pending).toBe("http://localhost/v2/admin/operations?status=pending&cursor=one&limit=20");
    expect(pending).not.toBe(responseCacheKey(
      "http://localhost/v2/admin/operations?status=executed&cursor=one&limit=20&nonce=1",
    ));
    expect(pending).not.toBe(responseCacheKey(
      "http://localhost/v2/admin/operations?status=pending&cursor=two&limit=20&nonce=1",
    ));
    expect(responseCacheKey("http://localhost/v2/flywheel?nonce=1"))
      .toBe(responseCacheKey("http://localhost/v2/flywheel?nonce=2"));
  });
});
