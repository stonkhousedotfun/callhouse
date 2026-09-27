/**
 * NotificationSettings: the wallet-signed alert editor, on the redesigned screen.
 * The channels are now a Tabs control (one tab per channel, its form in the tab's `panel`), the selected
 * channel's status is a Chip, and a tab carries an "On" badge when its channel is on.
 *
 * Node only (no jsdom), so the page is driven through a small hook harness: `react`'s state, ref, effect and
 * external-store hooks are swapped for in-memory slots while the component function runs, the returned element tree is
 * searched for the control under test, and its handler is called directly. The search walks EVERY prop value
 * (elements, arrays and plain objects), because the channel form now lives in `items[].panel` of the Tabs element, not
 * in `children`. A disabled control is never pressed: `click` refuses one, since a user cannot press it either. Tabs
 * are chosen through the Tabs element's `onChange`, and only for a tab that is not disabled. After a handler settles
 * the component is run again and the tree is rendered to markup with the real hooks (the harness is off then), so
 * every assertion reads what the page would show. The notifier client is mocked at its module boundary; the pure
 * helpers it exports stay real.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertPrefs, NotifierHealth, Subscription } from "@/lib/v2/notifier";

const h = vi.hoisted(() => ({
  active: false, cursor: 0, slots: [] as unknown[], effects: [] as (() => unknown)[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!h.active) return actual.useState(init);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.slots[i], (next: unknown) => {
        h.slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(h.slots[i]) : next;
      }];
    },
    useRef: (init: unknown) => {
      if (!h.active) return actual.useRef(init);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = { current: init };
      return h.slots[i];
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      if (!h.active) return actual.useEffect(fn as never, deps);
      h.effects.push(fn);
    },
    useSyncExternalStore: (subscribe: never, get: () => unknown, server?: () => unknown) =>
      h.active ? get() : actual.useSyncExternalStore(subscribe, get as never, server as never),
  };
});

const wagmi = vi.hoisted(() => ({
  address: undefined as `0x${string}` | undefined,
  wallet: undefined as undefined | { signMessage: ReturnType<typeof vi.fn> },
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wagmi.address }),
  useWalletClient: () => ({ data: wagmi.wallet }),
}));
const markets = vi.hoisted(() => ({ state: { data: undefined as { ticker: string }[] | undefined, isError: false } }));
vi.mock("@/lib/v2/hooks", () => ({ useMarkets: () => markets.state }));
vi.mock("@/components/ConnectButton", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => react.createElement("button", null, "Connect wallet") };
});

const api = vi.hoisted(() => ({
  base: "https://notify.test" as string | null,
  notifierHealth: vi.fn(), createNotifierSession: vi.fn(), listSubscriptions: vi.fn(),
  saveSubscription: vi.fn(), deleteSubscription: vi.fn(), telegramLink: vi.fn(), webPushKey: vi.fn(),
}));
vi.mock("@/lib/v2/notifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/notifier")>();
  return {
    ...actual,
    notifierBase: () => api.base,
    notifierHealth: api.notifierHealth, createNotifierSession: api.createNotifierSession,
    listSubscriptions: api.listSubscriptions, saveSubscription: api.saveSubscription,
    deleteSubscription: api.deleteSubscription, telegramLink: api.telegramLink, webPushKey: api.webPushKey,
  };
});
const push = vi.hoisted(() => ({ guidance: "supported" as string, ensurePushSubscription: vi.fn() }));
vi.mock("@/lib/v2/webPush", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/webPush")>()),
  pushGuidance: () => push.guidance,
  ensurePushSubscription: push.ensurePushSubscription,
}));

import { Chip, Notice, Tabs, type TabItem } from "@/components/ui";
import { ALERT_TOGGLES, DEFAULT_ALERT_PREFS } from "@/lib/v2/notifier";
import { enabledAlertTickers, alertMarketOptions } from "@/lib/v2/notificationMarkets";
import { NotificationSettings } from "./NotificationSettings";

const ADDRESS = "0x00000000000000000000000000000000000000aa" as const;
const LIVE = enabledAlertTickers(alertMarketOptions());
const HEALTHY: NotifierHealth = {
  status: "ok", database: "ok", telegramBot: "ok",
  channels: { telegram: "closed", webpush: "closed", email: "closed" },
};
const SESSION = { token: "t", address: ADDRESS, expiresAt: 1_800_000_000 + 3_600 };

function sub(over: Partial<Subscription>): Subscription {
  return { id: "s1", channel: "telegram", status: "active", target: null, prefs: { ...DEFAULT_ALERT_PREFS, priceAlerts: [] },
    createdAt: 1, verifiedAt: 1, disabledAt: null, disabledReason: null, ...over };
}

// ---- the harness ----
let tree: ReactNode = null;
function render(): string {
  const outer = NotificationSettings() as ReactElement<{ address: `0x${string}` | undefined }>;
  const Inner = outer.type as (props: { address: `0x${string}` | undefined }) => ReactNode;
  h.active = true; h.cursor = 0; h.effects = [];
  try { tree = Inner(outer.props); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return "";
}
type El = ReactElement<Record<string, unknown>>;
/** Every element in the tree, depth first, through every prop value: elements, arrays and plain objects. */
function collect(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
  if (isValidElement(node)) {
    out.push(node as El);
    collect(Object.values(node.props as Record<string, unknown>), out);
    return out;
  }
  if (node && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) collect(Object.values(node), out);
  return out;
}
const allElements = (): El[] => collect(tree, []);
const findEl = (pred: (el: El) => boolean): El | null => allElements().find(pred) ?? null;
function findControl(label: string | RegExp): El | null {
  return findEl((el) => (typeof el.props.onClick === "function" || typeof el.props.onChange === "function")
    && (typeof label === "string"
      ? textOf(el.props.children) === label || el.props["aria-label"] === label
      : label.test(textOf(el.props.children))));
}
function find(label: string | RegExp): El {
  const hit = findControl(label);
  if (!hit) throw new Error(`no control labelled ${String(label)}`);
  return hit;
}
function byProp(key: string, value: unknown): El {
  const hit = findEl((el) => el.props[key] === value);
  if (!hit) throw new Error(`no element with ${key}=${String(value)}`);
  return hit;
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
async function click(label: string | RegExp): Promise<string> {
  const control = find(label);
  if (control.props.disabled === true) throw new Error(`${String(label)} is disabled; a user cannot press it`);
  (control.props.onClick as () => void)();
  await flush();
  return render();
}
function change(label: string | El, value: string | boolean): string {
  const control = typeof label === "string" ? find(label) : label;
  (control.props.onChange as (e: unknown) => void)({ target: { value, checked: value } });
  return render();
}
async function runEffects(): Promise<string> {
  h.effects.forEach((fn) => fn());
  await flush();
  return render();
}
async function loaded(items: Subscription[], health: NotifierHealth = HEALTHY): Promise<string> {
  api.notifierHealth.mockResolvedValue(health);
  api.createNotifierSession.mockResolvedValue(SESSION);
  api.listSubscriptions.mockResolvedValue({ items });
  render();
  await runEffects();
  return click("Load my settings");
}
function channelTabs(): El {
  const hit = findEl((el) => el.type === Tabs);
  if (!hit) throw new Error("no channel tabs");
  return hit;
}
function tab(channel: string): TabItem<string> {
  const item = (channelTabs().props.items as TabItem<string>[]).find((entry) => entry.value === channel);
  if (!item) throw new Error(`no ${channel} tab`);
  return item;
}
/** Choose a channel's tab the way a user can: only when the tab is not disabled. */
function selectTab(channel: string): string {
  if (tab(channel).disabled) throw new Error(`the ${channel} tab is disabled; a user cannot choose it`);
  (channelTabs().props.onChange as (value: string) => void)(channel);
  return render();
}
/** The rendered tab button for a channel name, as markup. */
function tabButton(html: string, name: string): string {
  const hit = [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].find((m) => m[1]!.replace(/<[^>]+>/g, "").startsWith(name));
  if (!hit) throw new Error(`no rendered ${name} tab`);
  return hit[0];
}
/** The selected channel's status chip. */
function chip(): { text: string; tone: unknown } {
  const hit = findEl((el) => el.type === Chip);
  if (!hit) throw new Error("no status chip");
  return { text: textOf(hit.props.children), tone: hit.props.tone };
}
/** The tone of the notice showing exactly this text, or undefined when no notice shows it. */
function noticeTone(text: string): unknown {
  return findEl((el) => el.type === Notice && textOf(el.props.children) === text)?.props.tone;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
  h.slots = []; h.effects = [];
  wagmi.address = ADDRESS;
  wagmi.wallet = { signMessage: vi.fn(async () => "0xsig") };
  markets.state = { data: undefined, isError: false };
  api.base = "https://notify.test";
  push.guidance = "supported";
  for (const fn of [api.notifierHealth, api.createNotifierSession, api.listSubscriptions, api.saveSubscription,
    api.deleteSubscription, api.telegramLink, api.webPushKey, push.ensurePushSubscription]) fn.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("NotificationSettings: before a wallet or a service", () => {
  it("asks for a wallet and never reads the notifier's settings without one", async () => {
    wagmi.address = undefined;
    api.notifierHealth.mockResolvedValue(HEALTHY);
    render();
    const html = await runEffects();
    expect(html).toContain("Connect a wallet to manage its alerts.");
    expect(html).toContain("Connect wallet");
    expect(html).not.toContain("Your alert channels");
    expect(findControl("Load my settings")).toBeNull();
    expect(findEl((el) => el.type === Tabs)).toBeNull();
    expect(api.createNotifierSession).not.toHaveBeenCalled();
    expect(api.listSubscriptions).not.toHaveBeenCalled();
    expect((NotificationSettings() as ReactElement).key).toBe("disconnected");
  });

  it("keys the editor by wallet so a wallet switch drops the old session and edits", () => {
    expect((NotificationSettings() as ReactElement).key).toBe(ADDRESS);
    wagmi.address = "0x00000000000000000000000000000000000000bb";
    expect((NotificationSettings() as ReactElement).key).toBe("0x00000000000000000000000000000000000000bb");
  });

  it("says alerts are not available when no notifier URL is configured, and never calls it", async () => {
    api.base = null;
    render();
    const html = await runEffects();
    expect(html).toContain("Alerts aren&#x27;t available yet.");
    expect(api.notifierHealth).not.toHaveBeenCalled();
    expect(find("Load my settings").props.disabled).toBe(true);
  });

  it("reports an unreachable service, and its Try again recovers once the service answers", async () => {
    api.notifierHealth.mockRejectedValueOnce(new Error("down"));
    render();
    let html = await runEffects();
    expect(html).toContain("Alerts are unavailable right now.");
    expect(find("Load my settings").props.disabled).toBe(true);
    api.notifierHealth.mockRejectedValueOnce(new Error("still down"));
    html = await click("Try again");
    expect(html).toContain("Alerts are still unavailable. Try again later.");
    api.notifierHealth.mockResolvedValueOnce(HEALTHY);
    html = await click("Try again");
    expect(html).not.toContain("unavailable");
    expect(find("Load my settings").props.disabled).toBe(false);
  });

  it("ignores a health answer that lands after the page is gone", async () => {
    let resolve!: (value: NotifierHealth) => void;
    api.notifierHealth.mockReturnValue(new Promise((r) => { resolve = r; }));
    render();
    const cleanup = h.effects[0]!() as () => void;
    cleanup();
    resolve({ ...HEALTHY, status: "degraded" });
    await flush();
    expect(render()).not.toContain("partly down");
    expect(find("Load my settings").props.disabled).toBe(true);
  });

  it("warns when the service is degraded and keeps Load disabled until the database answers ok", async () => {
    api.notifierHealth.mockResolvedValue({ ...HEALTHY, status: "degraded", database: "unavailable" });
    render();
    let html = await runEffects();
    expect(html).toContain("Alerts are partly down. Saved settings may not load.");
    expect(find("Load my settings").props.disabled).toBe(true);
    api.notifierHealth.mockResolvedValue({ ...HEALTHY, status: "degraded", database: "ok" });
    html = await runEffects();
    expect(html).toContain("Alerts are partly down. Saved settings may not load.");
    expect(find("Load my settings").props.disabled).toBe(false);
  });

  it("keeps Load disabled without a wallet client to sign with", async () => {
    wagmi.wallet = undefined;
    api.notifierHealth.mockResolvedValue(HEALTHY);
    render();
    await runEffects();
    expect(find("Load my settings").props.disabled).toBe(true);
  });
});

describe("NotificationSettings: loading a wallet's channels", () => {
  it("signs once, shows the selected channel's status and alerts, and each other channel's on its own tab", async () => {
    const prefs: AlertPrefs = { ...DEFAULT_ALERT_PREFS, fills: false,
      priceAlerts: [{ ticker: LIVE[0]!, above: "221500000", below: "1000000" }] };
    let html = await loaded([
      sub({ id: "t-old", status: "disabled" }),
      sub({ id: "t", status: "active", target: "@me", prefs }),
      sub({ id: "e", channel: "email", status: "pending", target: "•••@x.io" }),
    ]);
    expect(api.createNotifierSession).toHaveBeenCalledTimes(1);
    expect(api.createNotifierSession.mock.calls[0]![1]).toBe(ADDRESS);
    expect(api.listSubscriptions).toHaveBeenCalledWith("https://notify.test", SESSION);
    expect(html).toContain("Alert status is up to date.");
    expect(noticeTone("Alert status is up to date.")).toBe("accent");
    expect(html).toContain("Refresh status");
    // Base units from the notifier are six-decimal USDG: 221500000 -> 221.5 and 1000000 -> 1. One row per direction.
    expect(find("Ticker for alert 1").props.value).toBe(LIVE[0]);
    expect(find("Direction for alert 1").props.value).toBe("above");
    expect(find("Price for alert 1").props.value).toBe("221.5");
    expect(find("Direction for alert 2").props.value).toBe("below");
    expect(find("Price for alert 2").props.value).toBe("1");
    expect(html).toContain('value="221.5"');
    expect(html).toMatch(/<option value="below" selected="">/);
    // The channel's saved toggles load too (fills was off).
    const boxes = allElements().filter((el) => el.props.type === "checkbox");
    expect(boxes.map((box) => box.props.checked)).toEqual(ALERT_TOGGLES.map((toggle) => prefs[toggle.key]));
    // The active item wins over the disabled one for the channel's status, on the chip and on the tab.
    expect(chip()).toEqual({ text: "On", tone: "accent" });
    expect(tab("telegram").badge).toBe("On");
    expect(html).toMatch(/Disabled<\/span>/);
    expect(html).toMatch(/On<\/span><span class="[^"]*">@me<\/span>/);
    // A pending channel is not badged "On"; its own tab shows its status and target.
    expect(tab("email").badge).toBeUndefined();
    expect(tab("webpush").badge).toBeUndefined();
    html = selectTab("email");
    expect(chip()).toEqual({ text: "Awaiting email confirmation", tone: "neutral" });
    expect(html).toContain("•••@x.io");
    expect(html).not.toContain("@me");
  });

  it("reuses the signed session instead of asking the wallet again on Refresh", async () => {
    await loaded([]);
    const html = await click("Refresh status");
    expect(api.createNotifierSession).toHaveBeenCalledTimes(1);
    expect(api.listSubscriptions).toHaveBeenCalledTimes(2);
    expect(html).toContain("No price alerts yet.");
  });

  it("the wallet's signature request is the notifier challenge, signed by the connected account", async () => {
    api.notifierHealth.mockResolvedValue(HEALTHY);
    api.listSubscriptions.mockResolvedValue({ items: [] });
    api.createNotifierSession.mockImplementation(async (_b: string, _a: string, sign: (m: string) => Promise<string>) => {
      expect(await sign("challenge")).toBe("0xsig");
      return SESSION;
    });
    render(); await runEffects();
    await click("Load my settings");
    expect(wagmi.wallet!.signMessage).toHaveBeenCalledWith({ account: ADDRESS, message: "challenge" });
  });

  it("drops a session the notifier calls invalid, so the next action signs again", async () => {
    await loaded([]);
    api.listSubscriptions.mockRejectedValueOnce(Object.assign(new Error("Session expired."), { code: "session-invalid" }));
    let html = await click("Refresh status");
    expect(html).toContain("Session expired.");
    expect(noticeTone("Session expired.")).toBe("warn");
    html = await click("Refresh status");
    expect(api.createNotifierSession).toHaveBeenCalledTimes(2);
    expect(html).toContain("Alert status is up to date.");
  });

  it("shows a generic message for a non-Error failure", async () => {
    await loaded([]);
    api.listSubscriptions.mockRejectedValueOnce("nope");
    expect(await click("Refresh status")).toContain("Could not update alerts. Try again.");
    expect(noticeTone("Could not update alerts. Try again.")).toBe("warn");
  });

  it("disables the tab of a channel the service has switched off, so it cannot be chosen, and badges it nothing", async () => {
    const html = await loaded([sub({ id: "e", channel: "email", status: "active", target: "•••@x.io" })],
      { ...HEALTHY, channels: { ...HEALTHY.channels, email: "off" } });
    expect(tab("email").disabled).toBe(true);
    expect(tab("telegram").disabled).toBe(false);
    expect(tabButton(html, "Email")).toContain('disabled=""');
    expect(tabButton(html, "Telegram")).not.toContain('disabled=""');
    // An active email item on a switched-off channel is not advertised as "On".
    expect(tab("email").badge).toBeUndefined();
    expect(() => selectTab("email")).toThrow(/disabled/);
  });

  it("a switched-off channel's tab says Unavailable in its label, which shows at every width", async () => {
    const html = await loaded([], { ...HEALTHY, channels: { ...HEALTHY.channels, telegram: "off" } });
    const off = tabButton(html, "Telegram");
    expect(off).toContain('disabled=""');
    // In the label, a block line: not a Tabs badge, which is `hidden` below `sm`.
    expect(off).toMatch(/<span data-slot="channel-unavailable" class="block [^"]*">Unavailable<\/span>/);
    expect(off.replace(/<[^>]+>/g, "")).toBe("Telegram Unavailable");
    expect(tabButton(html, "Browser")).not.toContain("Unavailable");
    expect(tabButton(html, "Email")).not.toContain("Unavailable");
  });
});

describe("NotificationSettings: price alert validation", () => {
  it("adds an alert on the first live ticker, and caps the list at 20", async () => {
    await loaded([]);
    let html = await click("Add alert");
    expect(html).toContain("Ticker for alert 1");
    expect(find("Ticker for alert 1").props.value).toBe(LIVE[0]);
    expect(find("Direction for alert 1").props.value).toBe("above");
    expect(find("Price for alert 1").props.value).toBe("");
    for (let i = 1; i < 20; i++) html = await click("Add alert");
    expect(html).toContain("Ticker for alert 20");
    expect(find("Add alert").props.disabled).toBe(true);
  });

  it("refuses to save a price that is not a positive six-decimal USDG figure", async () => {
    await loaded([]);
    await click("Add alert");
    for (const bad of ["", "0", "-1", "1.1234567", "abc"]) {
      change("Price for alert 1", bad);
      expect(await click("Save telegram alerts")).toContain("Use a positive USDG price with up to six decimal places.");
      expect(noticeTone("Use a positive USDG price with up to six decimal places.")).toBe("warn");
    }
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("refuses a ticker that is not a live market", async () => {
    await loaded([]);
    await click("Add alert");
    change("Ticker for alert 1", "NOTLIVE");
    change("Price for alert 1", "10");
    expect(await click("Save telegram alerts")).toContain("Choose a live ticker.");
    expect(noticeTone("Choose a live ticker.")).toBe("warn");
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("sends a valid alert to the notifier in six-decimal base units under its direction", async () => {
    api.saveSubscription.mockResolvedValue({ id: "t" });
    await loaded([]);
    await click("Add alert");
    change("Direction for alert 1", "below");
    change("Price for alert 1", "221.50");
    // The first toggle is ALERT_TOGGLES[0], strikeCross.
    expect(ALERT_TOGGLES[0]!.key).toBe("strikeCross");
    change(byProp("type", "checkbox"), false);
    const html = await click("Save telegram alerts");
    expect(api.saveSubscription).toHaveBeenCalledTimes(1);
    const [base, session, channel, prefs, target] = api.saveSubscription.mock.calls[0]!;
    expect(base).toBe("https://notify.test");
    expect(session).toBe(SESSION);
    expect(channel).toBe("telegram");
    expect(target).toBeUndefined();
    expect((prefs as AlertPrefs).priceAlerts).toEqual([{ ticker: LIVE[0], below: "221500000" }]);
    // Every other toggle is the first-save default (the protocol-wide kinds stay off).
    expect({ ...(prefs as AlertPrefs), priceAlerts: [] }).toEqual({ ...DEFAULT_ALERT_PREFS, strikeCross: false, priceAlerts: [] });
    expect(html).toContain("Alert preferences saved.");
    expect(noticeTone("Alert preferences saved.")).toBe("accent");
    // A new telegram item stays pending until the bot is linked.
    expect(html).toContain("Awaiting Telegram link");
    expect(chip().text).toBe("Awaiting Telegram link");
    expect(tab("telegram").badge).toBeUndefined();
  });

  it("removes a row before save", async () => {
    await loaded([]);
    await click("Add alert");
    expect(await click("Remove alert 1")).toContain("No price alerts yet.");
    expect(findControl("Price for alert 1")).toBeNull();
  });

  it("refuses more than 20 alerts loaded from the service", async () => {
    const priceAlerts = Array.from({ length: 21 }, () => ({ ticker: LIVE[0]!, above: "1000000" }));
    await loaded([sub({ prefs: { ...DEFAULT_ALERT_PREFS, priceAlerts } })]);
    expect(find("Add alert").props.disabled).toBe(true);
    expect(await click("Save telegram alerts")).toContain("Keep at most 20 price alerts for each channel.");
    expect(noticeTone("Keep at most 20 price alerts for each channel.")).toBe("warn");
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("offers no alert rows when the market feed is up but lists no live ticker", async () => {
    markets.state = { data: [], isError: false };
    const html = await loaded([]);
    expect(html).toContain("No live markets for price alerts yet.");
    expect(find("Add alert").props.disabled).toBe(true);
  });

  it("falls back to the built-in list, and says so, when the market feed fails", async () => {
    markets.state = { data: undefined, isError: true };
    const html = await loaded([]);
    expect(html).toContain("Showing the app&#x27;s built-in list.");
    expect(find("Add alert").props.disabled).toBe(false);
    await click("Add alert");
    expect(find("Ticker for alert 1").props.value).toBe(LIVE[0]);
  });
});

function setEmail(value: string) { change(byProp("id", "alert-email"), value); }

describe("NotificationSettings: email", () => {
  it("rejects an address that is not an email and saves a valid one as a pending, masked item", async () => {
    api.saveSubscription.mockResolvedValue({ id: "e" });
    await loaded([]);
    let html = selectTab("email");
    expect(html).toContain("Email address");
    expect(html).toContain('id="alert-email"');
    html = await click("Save email alerts");
    expect(html).toContain("Enter a valid email address to subscribe or update.");
    expect(noticeTone("Enter a valid email address to subscribe or update.")).toBe("warn");
    for (const bad of ["me", "me@", "me@example", "me @example.com"]) {
      setEmail(bad);
      expect(await click("Save email alerts")).toContain("Enter a valid email address to subscribe or update.");
    }
    expect(api.saveSubscription).not.toHaveBeenCalled();
    setEmail("  me@example.com ");
    html = await click("Save email alerts");
    expect(api.saveSubscription.mock.calls[0]![2]).toBe("email");
    expect(api.saveSubscription.mock.calls[0]![4]).toBe("me@example.com");
    expect(html).toContain("Saved. Check your inbox for the confirmation link.");
    expect(html).toContain("•••@example.com");
    expect(html).not.toContain("me@example.com</span>");
    expect(html).toContain("Awaiting email confirmation");
    expect(chip().text).toBe("Awaiting email confirmation");
  });

  it("keeps an already confirmed email active when its settings are re-saved", async () => {
    api.saveSubscription.mockResolvedValue({ id: "e" });
    await loaded([sub({ id: "e", channel: "email", status: "active", target: "•••@x.io" })]);
    selectTab("email");
    setEmail("a@x.io");
    const html = await click("Save email alerts");
    expect(api.saveSubscription.mock.calls[0]![4]).toBe("a@x.io");
    expect(html).toMatch(/On<\/span><span class="[^"]*">•••@x\.io<\/span>/);
    expect(html).not.toContain("Awaiting email confirmation");
    expect(chip()).toEqual({ text: "On", tone: "accent" });
  });
});

describe("NotificationSettings: telegram and turning a channel off", () => {
  it("fetches a Telegram deep link and offers it as a button", async () => {
    api.telegramLink.mockResolvedValue({ deepLink: "https://t.me/stonkhouse_bot?start=" + "a".repeat(32), expiresAt: 1 });
    let html = await loaded([]);
    expect(html).not.toContain("Open Telegram");
    html = await click("Get Telegram link");
    expect(api.telegramLink).toHaveBeenCalledWith("https://notify.test", SESSION);
    expect(html).toContain("Telegram link ready.");
    expect(html).toContain(`href="https://t.me/stonkhouse_bot?start=${"a".repeat(32)}"`);
    expect(html).toContain("Open Telegram");
  });

  it("disables the Telegram link while the service database is not ok, and enables it when ok", async () => {
    await loaded([], { ...HEALTHY, database: "ok" });
    expect(find("Get Telegram link").props.disabled).toBe(false);
    // Re-run the page's health check (the harness calls the effect again) with the database down.
    api.notifierHealth.mockResolvedValue({ ...HEALTHY, database: "unavailable" });
    await runEffects();
    expect(find("Get Telegram link").props.disabled).toBe(true);
  });

  it("turns off one subscription by id and names the channel", async () => {
    api.deleteSubscription.mockResolvedValue({ ok: true });
    await loaded([sub({ id: "t1", target: "@me" })]);
    expect(chip().text).toBe("On");
    const html = await click("Turn off");
    expect(api.deleteSubscription).toHaveBeenCalledWith("https://notify.test", SESSION, "t1");
    expect(html).toContain("Telegram alerts are off.");
    expect(html).not.toContain("@me");
    expect(chip().text).toBe("Off");
    expect(tab("telegram").badge).toBeUndefined();
  });

  it("disables Save for a channel the service has switched off", async () => {
    await loaded([], { ...HEALTHY, channels: { ...HEALTHY.channels, telegram: "off" } });
    expect(find("Save telegram alerts").props.disabled).toBe(true);
  });
});

describe("NotificationSettings: browser push", () => {
  function stubBrowser(permission: string, existing: object | null = { endpoint: "https://push.example/abc" }) {
    const registration = { pushManager: { getSubscription: vi.fn(async () => existing) } };
    const register = vi.fn(async () => registration);
    const requestPermission = vi.fn(async () => permission);
    vi.stubGlobal("navigator", { serviceWorker: { register }, userAgent: "x", maxTouchPoints: 0 });
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("Notification", { requestPermission });
    api.webPushKey.mockResolvedValue({ publicKey: "AQID" });
    const subscription = { endpoint: "https://push.example/abc", toJSON: () => ({ endpoint: "https://push.example/abc" }) };
    push.ensurePushSubscription.mockResolvedValue(subscription);
    return { register, registration, requestPermission };
  }

  it("enables push after permission, subscribes with the service's key and records an active item", async () => {
    const { register, requestPermission } = stubBrowser("granted");
    api.saveSubscription.mockResolvedValue({ id: "w" });
    await loaded([]);
    selectTab("webpush");
    const html = await click("Enable on this browser");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    // "AQID" is base64url for the bytes 1, 2, 3.
    expect(Array.from(push.ensurePushSubscription.mock.calls[0]![1] as Uint8Array)).toEqual([1, 2, 3]);
    expect(api.saveSubscription.mock.calls[0]![2]).toBe("webpush");
    expect(api.saveSubscription.mock.calls[0]![4]).toEqual({ endpoint: "https://push.example/abc" });
    expect(html).toContain("Browser alerts are on for this browser.");
    expect(html).toContain("push.example");
    expect(chip()).toEqual({ text: "On", tone: "accent" });
    expect(tab("webpush").badge).toBe("On");
  });

  it("stops when the browser refuses permission", async () => {
    const { register } = stubBrowser("denied");
    await loaded([]);
    selectTab("webpush");
    expect(await click("Enable on this browser")).toContain("Browser notifications were not allowed.");
    expect(register).not.toHaveBeenCalled();
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("stops without asking when the browser has no Notification API", async () => {
    const { requestPermission } = stubBrowser("granted");
    vi.stubGlobal("window", {});
    await loaded([]);
    selectTab("webpush");
    expect(await click("Enable on this browser")).toContain("This browser does not support notifications.");
    expect(noticeTone("This browser does not support notifications.")).toBe("warn");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("saves browser preferences against the existing push subscription", async () => {
    stubBrowser("granted");
    api.saveSubscription.mockResolvedValue({ id: "w" });
    await loaded([]);
    selectTab("webpush");
    const html = await click("Save browser alerts");
    expect(api.saveSubscription.mock.calls[0]![2]).toBe("webpush");
    expect(api.saveSubscription.mock.calls[0]![4]).toEqual({ endpoint: "https://push.example/abc" });
    expect(html).toContain("Alert preferences saved.");
  });

  it("will not save browser preferences before push is enabled", async () => {
    stubBrowser("granted", null);
    await loaded([]);
    selectTab("webpush");
    expect(await click("Save browser alerts")).toContain("Enable browser alerts first, then save their preferences.");
    expect(noticeTone("Enable browser alerts first, then save their preferences.")).toBe("warn");
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("will not save browser preferences in a browser without push", async () => {
    stubBrowser("granted");
    vi.stubGlobal("window", {});
    await loaded([]);
    selectTab("webpush");
    expect(await click("Save browser alerts")).toContain("This browser does not support push notifications.");
    expect(api.saveSubscription).not.toHaveBeenCalled();
  });

  it("on iOS outside the home screen, points to install and offers Telegram instead", async () => {
    push.guidance = "ios-install";
    stubBrowser("granted");
    await loaded([]);
    let html = selectTab("webpush");
    expect(html).toContain("add Stonkhouse to your Home Screen first");
    expect(findControl("Enable on this browser")).toBeNull();
    html = await click("Set up Telegram instead");
    expect(channelTabs().props.value).toBe("telegram");
    expect(html).toContain("Get Telegram link");
  });

  it("names Telegram unavailable rather than offering it when the service has it off", async () => {
    push.guidance = "mobile-unsupported";
    stubBrowser("granted");
    await loaded([], { ...HEALTHY, channels: { ...HEALTHY.channels, telegram: "off" } });
    const html = selectTab("webpush");
    expect(html).toContain("This mobile browser can&#x27;t show alerts.");
    expect(find("Telegram unavailable").props.disabled).toBe(true);
    expect(findControl("Set up Telegram instead")).toBeNull();
  });

  it("waits (Enable disabled) while the page cannot yet tell what the browser supports", async () => {
    await loaded([]);
    const html = selectTab("webpush");
    expect(html).toContain("Your browser asks for permission when you press Enable.");
    expect(find("Enable on this browser").props.disabled).toBe(true);
  });

  it("disables Enable in a desktop browser that cannot show alerts", async () => {
    push.guidance = "unsupported";
    stubBrowser("granted");
    await loaded([]);
    const html = selectTab("webpush");
    expect(html).toContain("This browser can&#x27;t show alerts.");
    expect(find("Enable on this browser").props.disabled).toBe(true);
  });
});
