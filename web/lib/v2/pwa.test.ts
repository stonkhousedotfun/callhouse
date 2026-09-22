import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import manifest from "@/app/manifest";

const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("installable web app manifest", () => {
  it("uses standalone mode and real 192px, 512px, and maskable icon assets", async () => {
    const value = manifest();
    expect(value).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      name: "Stonkhouse",
      short_name: "Stonkhouse",
    });
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }),
      expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }),
      expect.objectContaining({ src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }),
    ]));

    await expect(pngSize(join(WEB_ROOT, "public/icon-192.png"))).resolves.toEqual({ width: 192, height: 192 });
    await expect(pngSize(join(WEB_ROOT, "public/icon-512.png"))).resolves.toEqual({ width: 512, height: 512 });
    await expect(pngSize(join(WEB_ROOT, "public/icon-512-maskable.png"))).resolves.toEqual({ width: 512, height: 512 });
    await expect(pngSize(join(WEB_ROOT, "public/notification-badge.png"))).resolves.toEqual({ width: 96, height: 96 });
  });
});

type WorkerListener = (event: {
  data?: { json(): unknown };
  notification?: { close(): void; data?: { url?: string } };
  waitUntil(promise: Promise<unknown>): void;
}) => void;

async function serviceWorkerHarness() {
  const listeners = new Map<string, WorkerListener>();
  const showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => undefined);
  const matchAll = vi.fn(async () => [] as { url: string; focus(): Promise<unknown> }[]);
  const openWindow = vi.fn(async () => undefined);
  const scope = {
    location: { origin: "https://app.stonkhouse.fun" },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
  };
  const source = await readFile(join(WEB_ROOT, "public/sw.js"), "utf8");
  runInNewContext(source, { self: scope, URL });
  return { listeners, showNotification, matchAll, openWindow };
}

function dispatch(listener: WorkerListener, event: Omit<Parameters<WorkerListener>[0], "waitUntil">) {
  let pending: Promise<unknown> | undefined;
  listener({ ...event, waitUntil: (promise) => { pending = Promise.resolve(promise); } });
  return pending;
}

describe("push service worker", () => {
  it("shows same-origin notifications with icons, badge, and a deterministic per-message tag", async () => {
    const worker = await serviceWorkerHarness();
    const listener = worker.listeners.get("push");
    expect(listener).toBeDefined();
    const payload = { title: "Order filled", body: "Your NVDA order filled.", url: "/portfolio?tab=history", kind: "fill_receipt" };

    await dispatch(listener!, { data: { json: () => payload } });
    await dispatch(listener!, { data: { json: () => payload } });

    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    const firstOptions = worker.showNotification.mock.calls[0]![1];
    const secondOptions = worker.showNotification.mock.calls[1]![1];
    expect(firstOptions).toMatchObject({
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/notification-badge.png",
      data: { url: "/portfolio?tab=history" },
    });
    expect(firstOptions.tag).toMatch(/^stonkhouse-[0-9a-f]{8}$/u);
    expect(secondOptions.tag).toBe(firstOptions.tag);

    await dispatch(listener!, { data: { json: () => ({ ...payload, body: "A different fill." }) } });
    expect(worker.showNotification.mock.calls[2]![1].tag).not.toBe(firstOptions.tag);
  });

  it("keeps external notification URLs at the app root", async () => {
    const worker = await serviceWorkerHarness();
    const listener = worker.listeners.get("push")!;
    await dispatch(listener, { data: { json: () => ({ title: "Alert", body: "Open the app.", url: "https://evil.example/steal", kind: "price_alert" }) } });
    expect(worker.showNotification).toHaveBeenCalledWith("Alert", expect.objectContaining({ data: { url: "/" } }));
  });

  it("preserves click behavior by focusing an exact open URL or opening it", async () => {
    const worker = await serviceWorkerHarness();
    const listener = worker.listeners.get("notificationclick")!;
    const focus = vi.fn(async () => undefined);
    worker.matchAll.mockResolvedValueOnce([{ url: "https://app.stonkhouse.fun/portfolio", focus }]);
    const close = vi.fn();

    await dispatch(listener, { notification: { close, data: { url: "/portfolio" } } });
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(worker.openWindow).not.toHaveBeenCalled();

    worker.matchAll.mockResolvedValueOnce([]);
    await dispatch(listener, { notification: { close: vi.fn(), data: { url: "/wins" } } });
    expect(worker.openWindow).toHaveBeenCalledWith("https://app.stonkhouse.fun/wins");
  });
});
