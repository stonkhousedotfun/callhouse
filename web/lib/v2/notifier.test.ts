import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  baseUnitsToPrice, createNotifierSession, listSubscriptions, notifierBase, priceToBaseUnits,
  saveSubscription, sessionIsCurrent, telegramLink, ALERT_TOGGLES, DEFAULT_ALERT_PREFS, NotifierError,
} from "./notifier";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("notifier settings contract", () => {
  it("requires HTTPS for a remote notifier that receives wallet signatures and sessions", () => {
    for (const [value, expected] of [
      ["http://alerts.example", null],
      ["https://alerts.example/v1", "https://alerts.example"],
      ["http://localhost:42070", "http://localhost:42070"],
      ["http://127.0.0.1:42070", "http://127.0.0.1:42070"],
      ["http://[::1]:42070", "http://[::1]:42070"],
    ] as const) {
      vi.stubEnv("NEXT_PUBLIC_NOTIFIER_URL", value);
      expect(notifierBase()).toBe(expected);
    }
  });

  it("reuses only the current wallet's unexpired session", () => {
    const session = { token: "private", address: "0x1111111111111111111111111111111111111111", expiresAt: 1_000 };
    expect(sessionIsCurrent(session, session.address, 900)).toBe(true);
    expect(sessionIsCurrent(session, session.address, 971)).toBe(false);
    expect(sessionIsCurrent(session, "0x2222222222222222222222222222222222222222", 900)).toBe(false);
  });

  it("signs once to establish a session, then uses a bearer token for reads and writes", async () => {
    const address = "0x1111111111111111111111111111111111111111";
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const body = path === "/v1/challenge" ? { message: "Sign this exact challenge", nonce: "nonce-1" }
        : path === "/v1/session" ? { token: "session-token", address, expiresAt: 2_000_000_000 }
          : path === "/v1/subscriptions" && init.method === "POST" ? { id: "saved" }
            : path === "/v1/telegram/link" ? { deepLink: `https://t.me/stonkhouse_test_bot?start=${"a".repeat(32)}`, expiresAt: 2_000_000_000 }
              : { items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const sign = vi.fn(async () => "0xsig");
    const session = await createNotifierSession("https://alerts.example", address, sign);
    await listSubscriptions("https://alerts.example", session);
    await saveSubscription("https://alerts.example", session, "telegram", DEFAULT_ALERT_PREFS);
    await telegramLink("https://alerts.example", session);

    expect(sign).toHaveBeenCalledExactlyOnceWith("Sign this exact challenge");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ address, signature: "0xsig", nonce: "nonce-1" });
    expect(calls.slice(2).every((call) => (call.init.headers as Record<string, string>).authorization === "Bearer session-token")).toBe(true);
    expect(calls.slice(2).every((call) => !call.url.includes("0xsig"))).toBe(true);
    expect(calls.slice(2).every((call) => call.init.cache === "no-store" && call.init.credentials === "omit")).toBe(true);
  });

  it("shows a backend error without exposing the request body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "session-invalid", message: "Please sign in again." } }), { status: 401 })));
    const session = { token: "private", address: "0x1111111111111111111111111111111111111111", expiresAt: 2_000_000_000 };
    await expect(listSubscriptions("https://alerts.example", session)).rejects.toMatchObject({
      name: "Error", code: "session-invalid", message: "Please sign in again.",
    } satisfies Partial<NotifierError>);
  });

  it("rejects Telegram links that leave t.me, use unsafe schemes, or alter the start token", async () => {
    const session = { token: "private", address: "0x1111111111111111111111111111111111111111", expiresAt: 2_000_000_000 };
    const candidate = async (deepLink: string) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ deepLink, expiresAt: 2_000_000_000 }), { status: 200 })));
      return telegramLink("https://alerts.example", session);
    };
    for (const link of [
      "javascript:alert(1)",
      `https://t.me.evil.example/stonkhouse_test_bot?start=${"a".repeat(32)}`,
      `http://t.me/stonkhouse_test_bot?start=${"a".repeat(32)}`,
      `https://t.me/stonkhouse_test_bot?start=${"a".repeat(32)}&next=https://evil.example`,
      "https://t.me/stonkhouse_test_bot?start=short",
    ]) await expect(candidate(link)).rejects.toMatchObject({ code: "invalid-response" });
    await expect(candidate(`https://t.me/stonkhouse_test_bot?start=${"a".repeat(32)}`))
      .resolves.toEqual({ deepLink: `https://t.me/stonkhouse_test_bot?start=${"a".repeat(32)}`, expiresAt: 2_000_000_000 });
  });
});

describe("price alert amounts", () => {
  it("converts USDG decimal prices to exact six-decimal base units", () => {
    expect(priceToBaseUnits("221.50")).toBe("221500000");
    expect(priceToBaseUnits("0.000001")).toBe("1");
    expect(baseUnitsToPrice("221500000")).toBe("221.5");
    expect(baseUnitsToPrice("1")).toBe("0.000001");
  });

  it("rejects zero, negative, rounded, and out-of-range thresholds", () => {
    for (const value of ["0", "-1", "1.0000001", "1e3", "1000000000000", "0.000000", "1,000"])
      expect(priceToBaseUnits(value)).toBeNull();
  });
});

describe("alert toggles match the notifier's prefs contract", () => {
  // The notifier refuses an unknown key (prefs.ts `.strict()`), and a key the dapp never sends takes the
  // notifier's default. So the two lists must be the same set, with the same defaults. Read from the
  // notifier's source rather than imported, because web does not depend on zod's notifier copy.
  const prefsSource = readFileSync(fileURLToPath(new URL("../../../notifier/src/prefs.ts", import.meta.url)), "utf8");
  const notifierDefaults = Object.fromEntries(
    [...prefsSource.matchAll(/^\s+(\w+): z\.boolean\(\)\.default\((true|false)\),$/gm)].map(([, key, value]) => [key, value === "true"]),
  );

  it("reads the notifier's toggles (the parse is not vacuous)", () => {
    expect(Object.keys(notifierDefaults).length).toBeGreaterThanOrEqual(10);
    expect(notifierDefaults).toMatchObject({ strikeCross: true, feeNotice: false });
  });

  it("offers every notifier toggle, and no other", () => {
    expect(ALERT_TOGGLES.map((toggle) => toggle.key).sort()).toEqual(Object.keys(notifierDefaults).sort());
    const { priceAlerts, ...toggles } = DEFAULT_ALERT_PREFS;
    expect(priceAlerts).toEqual([]);
    expect(Object.keys(toggles).sort()).toEqual(Object.keys(notifierDefaults).sort());
  });

  it("defaults each toggle the way the notifier does", () => {
    const { priceAlerts: _priceAlerts, ...toggles } = DEFAULT_ALERT_PREFS;
    expect(toggles).toEqual(notifierDefaults);
  });

  it("keeps the three protocol-wide kinds off until the subscriber opts in", () => {
    expect(DEFAULT_ALERT_PREFS.feeNotice).toBe(false);
    expect(DEFAULT_ALERT_PREFS.adminOperation).toBe(false);
    expect(DEFAULT_ALERT_PREFS.marketLive).toBe(false);
    for (const key of ["feeNotice", "adminOperation", "marketLive"] as const) {
      const toggle = ALERT_TOGGLES.find((entry) => entry.key === key);
      expect(toggle?.label).toBeTruthy();
      expect(toggle?.detail).toBeTruthy();
    }
  });

  it("sends the three kinds explicitly on a first save", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ id: "saved" }), { status: 200 });
    }));
    const session = { token: "private", address: "0x1111111111111111111111111111111111111111", expiresAt: 2_000_000_000 };
    await saveSubscription("https://alerts.example", session, "telegram", DEFAULT_ALERT_PREFS);
    expect(bodies[0]).toMatchObject({ prefs: { feeNotice: false, adminOperation: false, marketLive: false } });
  });
});
