"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { v2Markets } from "@/lib/markets";
import {
  ALERT_TOGGLES, DEFAULT_ALERT_PREFS, baseUnitsToPrice, createNotifierSession,
  deleteSubscription, listSubscriptions, notifierBase, notifierHealth, priceToBaseUnits,
  saveSubscription, sessionIsCurrent, telegramLink, vapidKeyBytes, webPushKey,
  type AlertPrefs, type Channel, type NotifierHealth, type NotifierSession, type PriceAlert, type Subscription,
} from "@/lib/v2/notifier";

type AlertRow = { ticker: string; direction: "above" | "below"; price: string };
const CHANNELS: readonly { key: Channel; name: string; detail: string }[] = [
  { key: "telegram", name: "Telegram", detail: "Receive alerts in a private chat with the Stonkhouse bot." },
  { key: "webpush", name: "Browser", detail: "Receive alerts on this browser after you allow notifications." },
  { key: "email", name: "Email", detail: "Receive alerts after confirming the email address." },
];
const TICKERS = v2Markets().map((market) => market.ticker);

function rowsFromPrefs(prefs: AlertPrefs): AlertRow[] {
  return prefs.priceAlerts.flatMap((alert) => [
    ...(alert.above ? [{ ticker: alert.ticker, direction: "above" as const, price: baseUnitsToPrice(alert.above) }] : []),
    ...(alert.below ? [{ ticker: alert.ticker, direction: "below" as const, price: baseUnitsToPrice(alert.below) }] : []),
  ]);
}

function parsedAlerts(rows: AlertRow[]): PriceAlert[] {
  if (rows.length > 20) throw new Error("Keep at most 20 price alerts for each channel.");
  return rows.map((row) => {
    if (!TICKERS.includes(row.ticker)) throw new Error("Choose a ticker from the market list.");
    const amount = priceToBaseUnits(row.price);
    if (amount === null) throw new Error("Use a positive USDG price with up to six decimal places.");
    return { ticker: row.ticker, [row.direction]: amount };
  });
}

function channelStatus(item: Subscription | undefined): string {
  if (!item) return "Off";
  if (item.status === "active") return "On";
  if (item.status === "pending") return item.channel === "email" ? "Awaiting email confirmation" : "Awaiting Telegram link";
  return "Disabled";
}

function preferredItem(items: Subscription[], channel: Channel): Subscription | undefined {
  return items.find((item) => item.channel === channel && item.status === "active")
    ?? items.find((item) => item.channel === channel && item.status === "pending")
    ?? items.find((item) => item.channel === channel);
}

export function NotificationSettings() {
  const { address } = useAccount();
  return <WalletNotifications key={address ?? "disconnected"} address={address} />;
}

function WalletNotifications({ address }: { address: `0x${string}` | undefined }) {
  const wallet = useWalletClient();
  const base = notifierBase();
  const session = useRef<NotifierSession | null>(null);
  const [health, setHealth] = useState<NotifierHealth | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [items, setItems] = useState<Subscription[] | null>(null);
  const [selected, setSelected] = useState<Channel>("telegram");
  const [prefs, setPrefs] = useState<AlertPrefs>({ ...DEFAULT_ALERT_PREFS, priceAlerts: [] });
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ deepLink: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "accent" | "warn"; text: string } | null>(null);

  useEffect(() => {
    if (!base) return;
    let alive = true;
    notifierHealth(base).then((state) => {
      if (alive) { setHealth(state); setServiceError(null); }
    }).catch(() => {
      if (alive) { setHealth(null); setServiceError("Alerts are temporarily unavailable. Trading and portfolio pages still work."); }
    });
    return () => { alive = false; };
  }, [base]);

  async function getSession(): Promise<NotifierSession> {
    if (!base || !address || !wallet.data) throw new Error("Connect your wallet to manage alerts.");
    const cached = session.current;
    if (sessionIsCurrent(cached, address)) return cached;
    const next = await createNotifierSession(base, address, (text) => wallet.data!.signMessage({ account: address, message: text }));
    session.current = next;
    return next;
  }

  async function act(task: () => Promise<string>): Promise<void> {
    setBusy(true); setMessage(null);
    try {
      setMessage({ tone: "accent", text: await task() });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "session-invalid") session.current = null;
      setMessage({ tone: "warn", text: error instanceof Error ? error.message : "Could not update alerts. Try again." });
    } finally { setBusy(false); }
  }

  async function refresh(): Promise<string> {
    if (!base) throw new Error("Alert service is not configured.");
    const loaded = await listSubscriptions(base, await getSession());
    setItems(loaded.items);
    const current = preferredItem(loaded.items, selected);
    if (current?.prefs) { setPrefs(current.prefs); setAlerts(rowsFromPrefs(current.prefs)); }
    return "Alert status is up to date.";
  }

  function selectChannel(channel: Channel) {
    setSelected(channel); setMessage(null);
    const existing = preferredItem(items ?? [], channel);
    const nextPrefs = existing?.prefs ?? DEFAULT_ALERT_PREFS;
    setPrefs({ ...nextPrefs, priceAlerts: [...nextPrefs.priceAlerts] });
    setAlerts(rowsFromPrefs(nextPrefs));
  }

  async function pushTarget(): Promise<PushSubscriptionJSON> {
    if (!base || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      throw new Error("This browser does not support push notifications.");
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const existing = await registration.pushManager.getSubscription();
    if (!existing) throw new Error("Enable browser alerts first, then save their preferences.");
    return existing.toJSON();
  }

  async function enablePush() {
    // Ask while still in the button's user gesture. No permission request runs during page load.
    if (!("Notification" in window)) { setMessage({ tone: "warn", text: "This browser does not support notifications." }); return; }
    const permission = Notification.requestPermission();
    await act(async () => {
      if (await permission !== "granted") throw new Error("Browser notifications were not allowed. You can change this in browser settings.");
      if (!base || !("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("This browser does not support push notifications.");
      const key = await webPushKey(base);
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: vapidKeyBytes(key.publicKey),
      });
      const currentPrefs = { ...prefs, priceAlerts: parsedAlerts(alerts) };
      const saved = await saveSubscription(base, await getSession(), "webpush", currentPrefs, subscription.toJSON());
      setItems((before) => [
        ...(before ?? []).filter((item) => item.id !== saved.id),
        { id: saved.id, channel: "webpush", status: "active", target: new URL(subscription.endpoint).host,
          prefs: currentPrefs, createdAt: Date.now() / 1000, verifiedAt: Date.now() / 1000, disabledAt: null, disabledReason: null },
      ]);
      return "Browser alerts are on for this browser.";
    });
  }

  async function savePrefs() {
    await act(async () => {
      if (!base) throw new Error("Alert service is not configured.");
      const nextPrefs = { ...prefs, priceAlerts: parsedAlerts(alerts) };
      let target: unknown;
      if (selected === "webpush") target = await pushTarget();
      if (selected === "email") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error("Enter a valid email address to subscribe or update.");
        target = email.trim();
      }
      const saved = await saveSubscription(base, await getSession(), selected, nextPrefs, target);
      const old = items?.find((item) => item.id === saved.id);
      const status = selected === "webpush" ? "active"
        : selected === "email" ? (old?.status === "active" ? "active" : "pending")
          : old?.status ?? "pending";
      setItems((before) => [
        ...(before ?? []).filter((item) => item.id !== saved.id),
        { id: saved.id, channel: selected, status,
          target: old?.target ?? (selected === "email" ? email.trim().replace(/^[^@]+/, "•••") : null),
          prefs: nextPrefs, createdAt: old?.createdAt ?? Date.now() / 1000, verifiedAt: old?.verifiedAt ?? null,
          disabledAt: null, disabledReason: null },
      ]);
      setPrefs(nextPrefs);
      return selected === "email" ? "Saved. Check your inbox for the confirmation link." : "Alert preferences saved.";
    });
  }

  async function remove(item: Subscription) {
    await act(async () => {
      if (!base) throw new Error("Alert service is not configured.");
      await deleteSubscription(base, await getSession(), item.id);
      setItems((before) => before?.filter((entry) => entry.id !== item.id) ?? []);
      return `${CHANNELS.find((channel) => channel.key === item.channel)?.name ?? "Channel"} alerts are off.`;
    });
  }

  async function makeTelegramLink() {
    await act(async () => {
      if (!base) throw new Error("Alert service is not configured.");
      const next = await telegramLink(base, await getSession());
      setLink(next);
      return "Open the Telegram link below. Return here and refresh status after starting the bot.";
    });
  }

  const channelItems = items?.filter((item) => item.channel === selected) ?? [];
  const configured = base !== null;
  const serviceReady = health?.database === "ok";

  return <>
    <PageHead eyebrow="Settings" title="Notifications" lede="Choose where to receive fills, price alerts, and settlement updates." />
    {!configured ? <Notice tone="info" title="Alerts are not configured" role="status">This app has no notifier URL yet. Trading and your portfolio still work.</Notice> : null}
    {serviceError ? <Notice tone="warn" title="Alert service unavailable" role="status" className="mb-5">{serviceError}
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void notifierHealth(base!).then((state) => { setHealth(state); setServiceError(null); }).catch(() => setServiceError("Alerts are still unavailable. Try again later."))}>Try again</Button>
    </Notice> : null}
    {health?.status === "degraded" ? <Notice tone="warn" title="Alert service is degraded" className="mb-5">Saved settings may not be available until it recovers.</Notice> : null}
    {!address ? <Panel><p className="mb-4 text-ink-2">Connect a wallet to manage its alerts.</p><ConnectButton /></Panel> : <>
      <Panel className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-display text-lg font-bold">Your channels</h2>
            <p className="mt-1 text-sm text-ink-2">One wallet signature starts a 30-minute settings session. You can review and change alerts until it expires.</p></div>
          <Button variant="ghost" size="sm" disabled={!serviceReady || busy || !wallet.data} onClick={() => void act(refresh)}>{items ? "Refresh status" : "Load my settings"}</Button>
        </div>
        {items === null ? <p className="mt-4 text-sm text-ink-3">Load your settings to see channel status. Your wallet will ask you to sign a message.</p> :
          <div className="mt-5 grid gap-3 sm:grid-cols-3">{CHANNELS.map((channel) => {
            const item = preferredItem(items, channel.key);
            const off = health?.channels[channel.key] === "off";
            return <button type="button" key={channel.key} onClick={() => selectChannel(channel.key)} aria-pressed={selected === channel.key}
              disabled={off} className={`min-w-0 rounded-md border p-4 text-left disabled:opacity-55 ${selected === channel.key ? "border-accent bg-accent-soft" : "border-line-2 bg-surface-2"}`}>
              <span className="block font-semibold">{channel.name}</span>
              <span className="mt-1 block text-sm text-ink-2">{channel.detail}</span>
              <span className="mt-3 block text-xs font-semibold text-accent-text">{off ? "Unavailable" : channelStatus(item)}</span>
              {item?.target ? <span className="mt-1 block break-all text-xs text-ink-2">{item.target}</span> : null}
            </button>;
          })}</div>}
      </Panel>
      {items ? <Panel as="section" aria-label={`${selected} alert preferences`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-display text-xl font-bold">{CHANNELS.find((channel) => channel.key === selected)?.name} alerts</h2>
            <p className="mt-1 text-sm text-ink-2">Choose what this channel sends. Price alerts are per channel.</p></div>
        </div>
        {channelItems.length ? <div className="mt-4 space-y-2">{channelItems.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm">
          <span><span className="font-semibold">{channelStatus(item)}</span>{item.target ? <span className="ml-2 text-ink-2">{item.target}</span> : null}</span>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => void remove(item)}>Turn off</Button>
        </div>)}</div> : null}
        {selected === "telegram" ? <div className="mt-5 rounded-md bg-surface-2 p-4">
          <p className="text-sm text-ink-2">Link your wallet to a Telegram chat. The link expires after 15 minutes.</p>
          <Button variant="ghost" size="sm" className="mt-3" disabled={busy || !serviceReady} onClick={() => void makeTelegramLink()}>Get Telegram link</Button>
          {link ? <div className="mt-3"><Button href={link.deepLink} size="sm">Open Telegram</Button><p className="mt-2 text-xs text-ink-3">After you start the bot, return and refresh status.</p></div> : null}
        </div> : null}
        {selected === "webpush" ? <div className="mt-5 rounded-md bg-surface-2 p-4">
          <p className="text-sm text-ink-2">Browser alerts work on this device. Your browser asks permission only when you press Enable.</p>
          <Button variant="ghost" size="sm" className="mt-3" disabled={busy || !serviceReady || !wallet.data} onClick={() => void enablePush()}>Enable on this browser</Button>
        </div> : null}
        {selected === "email" ? <div className="mt-5">
          <label htmlFor="alert-email" className="block text-sm font-semibold">Email address</label>
          <input id="alert-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com"
            className="mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
          <p className="mt-1 text-xs text-ink-3">The notifier sends a confirmation link before any alerts arrive. Re-enter your address to change its preferences.</p>
        </div> : null}
        <div className="mt-6 border-t border-line pt-5"><h3 className="font-display text-lg font-bold">Updates</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{ALERT_TOGGLES.map((toggle) => <label key={toggle.key} className="flex cursor-pointer gap-3 rounded-sm border border-line p-3">
            <input type="checkbox" checked={prefs[toggle.key]} onChange={(event) => setPrefs((before) => ({ ...before, [toggle.key]: event.target.checked }))} className="mt-1" />
            <span><span className="block text-sm font-semibold">{toggle.label}</span><span className="block text-xs text-ink-3">{toggle.detail}</span></span>
          </label>)}</div>
        </div>
        <div className="mt-6 border-t border-line pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-display text-lg font-bold">Price alerts</h3><p className="mt-1 text-sm text-ink-2">Notify when a Stock Token price crosses your USDG threshold.</p></div>
            <Button size="sm" variant="ghost" disabled={alerts.length >= 20} onClick={() => setAlerts((before) => [...before, { ticker: TICKERS[0] ?? "NVDA", direction: "above", price: "" }])}>Add alert</Button></div>
          {alerts.length === 0 ? <p className="mt-3 text-sm text-ink-3">No price thresholds for this channel.</p> :
            <div className="mt-4 space-y-3">{alerts.map((row, index) => <div key={index} className="grid min-w-0 gap-2 rounded-sm border border-line p-3 sm:grid-cols-[1fr_1fr_1.25fr_auto]">
              <label className="text-xs font-semibold text-ink-2">Ticker<select aria-label={`Ticker for alert ${index + 1}`} value={row.ticker} onChange={(event) => setAlerts((before) => before.map((entry, i) => i === index ? { ...entry, ticker: event.target.value } : entry))}
                className="mt-1 block min-h-10 w-full rounded-sm border border-line-2 bg-surface px-2 text-sm text-ink">{TICKERS.map((ticker) => <option key={ticker}>{ticker}</option>)}</select></label>
              <label className="text-xs font-semibold text-ink-2">Crosses<select aria-label={`Direction for alert ${index + 1}`} value={row.direction} onChange={(event) => setAlerts((before) => before.map((entry, i) => i === index ? { ...entry, direction: event.target.value as AlertRow["direction"] } : entry))}
                className="mt-1 block min-h-10 w-full rounded-sm border border-line-2 bg-surface px-2 text-sm text-ink"><option value="above">Above</option><option value="below">Below</option></select></label>
              <label className="text-xs font-semibold text-ink-2">Price in USDG<input aria-label={`Price for alert ${index + 1}`} inputMode="decimal" value={row.price} onChange={(event) => setAlerts((before) => before.map((entry, i) => i === index ? { ...entry, price: event.target.value } : entry))}
                placeholder="221.50" className="num mt-1 block min-h-10 w-full rounded-sm border border-line-2 bg-surface px-2 text-sm text-ink" /></label>
              <Button size="xs" variant="ghost" className="self-end" onClick={() => setAlerts((before) => before.filter((_, i) => i !== index))} aria-label={`Remove alert ${index + 1}`}>Remove</Button>
            </div>)}</div>}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3"><Button disabled={busy || !serviceReady || health?.channels[selected] === "off"} onClick={() => void savePrefs()}>{busy ? "Saving…" : `Save ${selected === "webpush" ? "browser" : selected} alerts`}</Button>
          <p className="text-xs text-ink-3">Changes apply to this channel after you save.</p></div>
      </Panel> : null}
      {message ? <Notice role="status" tone={message.tone} className="mt-5">{message.text}</Notice> : null}
    </>}
  </>;
}
