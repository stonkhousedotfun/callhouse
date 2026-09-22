import { describe, expect, it, vi } from "vitest";

import {
  applicationServerKeyMatches,
  ensurePushSubscription,
  pushGuidance,
  type PushRuntime,
} from "./webPush";

function key(...bytes: number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>;
}

function subscription(
  bytes: readonly number[] | null,
  unsubscribe = vi.fn(async () => true),
): PushSubscription {
  return {
    options: { applicationServerKey: bytes ? key(...bytes).buffer : null },
    unsubscribe,
  } as unknown as PushSubscription;
}

function manager(existing: PushSubscription | null, created = subscription([9, 9, 9])) {
  return {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async () => created),
  } satisfies Pick<PushManager, "getSubscription" | "subscribe">;
}

describe("web push application-server-key reconciliation", () => {
  it("reuses an existing subscription only when its key matches byte-for-byte", async () => {
    const existing = subscription([1, 2, 3]);
    const pushManager = manager(existing);

    expect(applicationServerKeyMatches(existing, key(1, 2, 3))).toBe(true);
    expect(applicationServerKeyMatches(existing, key(1, 2, 4))).toBe(false);
    expect(applicationServerKeyMatches(existing, key(1, 2, 3, 0))).toBe(false);
    await expect(ensurePushSubscription(pushManager, key(1, 2, 3))).resolves.toBe(existing);
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes a mismatched key before creating the replacement", async () => {
    const calls: string[] = [];
    const existing = subscription([1, 2, 3], vi.fn(async () => { calls.push("unsubscribe"); return true; }));
    const replacement = subscription([4, 5, 6]);
    const pushManager = {
      getSubscription: vi.fn(async () => existing),
      subscribe: vi.fn(async (options: PushSubscriptionOptionsInit) => {
        calls.push("subscribe");
        expect(Array.from(options.applicationServerKey as Uint8Array<ArrayBuffer>)).toEqual([4, 5, 6]);
        return replacement;
      }),
    } satisfies Pick<PushManager, "getSubscription" | "subscribe">;

    await expect(ensurePushSubscription(pushManager, key(4, 5, 6))).resolves.toBe(replacement);
    expect(calls).toEqual(["unsubscribe", "subscribe"]);
  });

  it("subscribes directly when this browser has no existing subscription", async () => {
    const replacement = subscription([7, 8]);
    const pushManager = manager(null, replacement);

    await expect(ensurePushSubscription(pushManager, key(7, 8))).resolves.toBe(replacement);
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it("fails closed when the old subscription cannot be removed", async () => {
    const existing = subscription([1], vi.fn(async () => false));
    const pushManager = manager(existing);

    await expect(ensurePushSubscription(pushManager, key(2))).rejects.toThrow("could not replace its old push key");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("propagates browser lookup, unsubscribe, and subscribe errors without continuing", async () => {
    const lookupError = new Error("lookup failed");
    const lookupManager = {
      getSubscription: vi.fn(async () => { throw lookupError; }),
      subscribe: vi.fn(),
    } as unknown as Pick<PushManager, "getSubscription" | "subscribe">;
    await expect(ensurePushSubscription(lookupManager, key(1))).rejects.toBe(lookupError);
    expect(lookupManager.subscribe).not.toHaveBeenCalled();

    const unsubscribeError = new Error("unsubscribe failed");
    const existing = subscription([1], vi.fn(async () => { throw unsubscribeError; }));
    const unsubscribeManager = manager(existing);
    await expect(ensurePushSubscription(unsubscribeManager, key(2))).rejects.toBe(unsubscribeError);
    expect(unsubscribeManager.subscribe).not.toHaveBeenCalled();

    const subscribeError = new Error("subscribe failed");
    const subscribeManager = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => { throw subscribeError; }),
    } as unknown as Pick<PushManager, "getSubscription" | "subscribe">;
    await expect(ensurePushSubscription(subscribeManager, key(3))).rejects.toBe(subscribeError);
  });
});

const BASE_RUNTIME: PushRuntime = {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  maxTouchPoints: 0,
  standalone: false,
  displayModeStandalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
};

describe("browser push guidance", () => {
  it("requires the installed Home Screen app on iPhone and iPad", () => {
    expect(pushGuidance({ ...BASE_RUNTIME, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }))
      .toBe("ios-install");
    expect(pushGuidance({ ...BASE_RUNTIME, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", maxTouchPoints: 5 }))
      .toBe("ios-install");
    expect(pushGuidance({ ...BASE_RUNTIME, userAgent: "Mozilla/5.0 (iPhone)", standalone: true }))
      .toBe("supported");
  });

  it("distinguishes unsupported mobile browsers from unsupported desktop browsers", () => {
    const noPush = { hasPushManager: false, hasNotification: false };
    expect(pushGuidance({ ...BASE_RUNTIME, ...noPush, userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile" }))
      .toBe("mobile-unsupported");
    expect(pushGuidance({ ...BASE_RUNTIME, ...noPush })).toBe("unsupported");
    expect(pushGuidance(BASE_RUNTIME)).toBe("supported");
  });
});
