"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { Button, Chip, FieldLabel, InfoTip, inputClasses, Notice, PageHead, Panel, Tabs } from "@/components/ui";
import { useMarkets } from "@/lib/v2/hooks";
import {
  ALERT_TOGGLES, DEFAULT_ALERT_PREFS, baseUnitsToPrice, createNotifierSession,
  deleteSubscription, listSubscriptions, notifierBase, notifierHealth, priceToBaseUnits,
  saveSubscription, sessionIsCurrent, telegramLink, vapidKeyBytes, webPushKey,
  type AlertPrefs, type Channel, type NotifierHealth, type NotifierSession, type PriceAlert, type Subscription,
} from "@/lib/v2/notifier";
import { alertMarketOptionsForQueryState, enabledAlertTickers } from "@/lib/v2/notificationMarkets";
import { ensurePushSubscription, pushGuidance, type PushGuidance } from "@/lib/v2/webPush";

type AlertRow = { ticker: string; direction: "above" | "below"; price: string };
const CHANNELS: readonly { key: Channel; name: string; detail: string }[] = [
  { key: "telegram", name: "Telegram", detail: "A private chat with the Stonkhouse bot." },
  { key: "webpush", name: "Browser", detail: "Notifications on this browser." },
  { key: "email", name: "Email", detail: "Alerts by email, once you confirm it." },
];
function rowsFromPrefs(prefs: AlertPrefs): AlertRow[] {
  return prefs.priceAlerts.flatMap((alert) => [
    ...(alert.above ? [{ ticker: alert.ticker, direction: "above" as const, price: baseUnitsToPrice(alert.above) }] : []),
    ...(alert.below ? [{ ticker: alert.ticker, direction: "below" as const, price: baseUnitsToPrice(alert.below) }] : []),
  ]);
}

function parsedAlerts(rows: AlertRow[], enabledTickers: readonly string[]): PriceAlert[] {
  if (rows.length > 20) throw new Error("Keep at most 20 price alerts for each channel.");
  return rows.map((row) => {
    if (!enabledTickers.includes(row.ticker)) throw new Error("Choose a live ticker.");
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

function subscribeBrowserPush(): () => void {
  return () => undefined;
}

function browserPushSnapshot(): PushGuidance | "checking" {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "checking";
  const extendedNavigator = navigator as Navigator & {
    standalone?: boolean;
    userAgentData?: { mobile?: boolean };
  };
  return pushGuidance({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    userAgentDataMobile: extendedNavigator.userAgentData?.mobile,
    standalone: extendedNavigator.standalone === true,
    displayModeStandalone: window.matchMedia?.("(display-mode: standalone)").matches === true,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
  });
}

export function NotificationSettings() {
  const { address } = useAccount();
  return <WalletNotifications key={address ?? "disconnected"} address={address} />;
}

function WalletNotifications({ address }: { address: `0x${string}` | undefined }) {
  const wallet = useWalletClient();
  const markets = useMarkets();
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
  const browserPush = useSyncExternalStore(subscribeBrowserPush, browserPushSnapshot, () => "checking");
  const marketOptions = alertMarketOptionsForQueryState(
    markets.data?.map((market) => market.ticker),
    markets.isError,
  );
  const enabledTickers = enabledAlertTickers(marketOptions);

  useEffect(() => {
    if (!base) return;
    let alive = true;
    notifierHealth(base).then((state) => {
      if (alive) { setHealth(state); setServiceError(null); }
    }).catch(() => {
      if (alive) { setHealth(null); setServiceError("Alerts are unavailable right now."); }
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
    const key = await webPushKey(base);
    return (await ensurePushSubscription(registration.pushManager, vapidKeyBytes(key.publicKey))).toJSON();
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
      const subscription = await ensurePushSubscription(registration.pushManager, vapidKeyBytes(key.publicKey));
      const currentPrefs = { ...prefs, priceAlerts: parsedAlerts(alerts, enabledTickers) };
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
      const nextPrefs = { ...prefs, priceAlerts: parsedAlerts(alerts, enabledTickers) };
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
      return "Telegram link ready.";
    });
  }

  const channelItems = items?.filter((item) => item.channel === selected) ?? [];
  const configured = base !== null;
  const serviceReady = health?.database === "ok";
  const telegramUnavailable = health?.channels.telegram === "off";

  const channelName = CHANNELS.find((channel) => channel.key === selected)?.name;
  const selectClasses = `${inputClasses} appearance-none px-3 py-2.5 font-body text-[14px]`;
  const channelForm = <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-1.5 text-[17px] font-bold">{channelName} alerts
        <InfoTip label="About channel alerts">Each channel keeps its own updates and price alerts. Choose what this channel sends.</InfoTip></h2>
      <Chip tone={channelStatus(preferredItem(items ?? [], selected)) === "On" ? "accent" : "neutral"} dot>{channelStatus(preferredItem(items ?? [], selected))}</Chip>
    </div>
    {channelItems.length ? <ul className="grid gap-2">{channelItems.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-field px-3.5 py-2.5 text-sm">
      <span className="min-w-0"><span className="font-semibold">{channelStatus(item)}</span>{item.target ? <span className="ml-2 break-all text-ink-2">{item.target}</span> : null}</span>
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => void remove(item)}>Turn off</Button>
    </li>)}</ul> : null}
    {selected === "telegram" ? <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-field px-4 py-3.5">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold">Link a Telegram chat <InfoTip label="About the Telegram link">Link your
        wallet to a private chat with the Stonkhouse bot. The link lasts 15 minutes. After you start the bot, come back and refresh status.</InfoTip></p>
      <Button variant="ghost" size="sm" disabled={busy || !serviceReady} onClick={() => void makeTelegramLink()}>Get Telegram link</Button>
      {link ? <Button href={link.deepLink} size="sm">Open Telegram</Button> : null}
    </div> : null}
    {selected === "webpush" ? <div className="flex flex-col gap-3 rounded-md border border-line bg-field px-4 py-3.5">
      {browserPush === "ios-install" ? <p className="text-sm text-ink-2">On iPhone and iPad, add Stonkhouse to your Home Screen first (in Safari: Share, then Add to Home Screen), open it from there and enable alerts.</p>
        : browserPush === "mobile-unsupported" ? <p className="text-sm text-ink-2">This mobile browser can&apos;t show alerts.</p>
          : browserPush === "unsupported" ? <p className="text-sm text-ink-2">This browser can&apos;t show alerts. Try another browser or channel.</p>
            : <p className="text-sm text-ink-2">Your browser asks for permission when you press Enable.</p>}
      {browserPush === "ios-install" || browserPush === "mobile-unsupported" ? <Button variant="ghost" size="sm" className="self-start"
        disabled={busy || telegramUnavailable} onClick={() => selectChannel("telegram")}>{telegramUnavailable ? "Telegram unavailable" : "Set up Telegram instead"}</Button>
        : <Button variant="ghost" size="sm" className="self-start" disabled={browserPush !== "supported" || busy || !serviceReady || !wallet.data}
          onClick={() => void enablePush()}>Enable on this browser</Button>}
    </div> : null}
    {selected === "email" ? <div className="grid gap-1.5">
      <FieldLabel htmlFor="alert-email" tip="We email a confirmation link first. Re-enter your address to change its settings.">Email address</FieldLabel>
      <input id="alert-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com"
        className={`${inputClasses} px-3.5 py-3 font-body text-[15px]`} />
    </div> : null}
    <section aria-labelledby="alert-updates-title" className="flex flex-col gap-3">
      <h3 id="alert-updates-title" className="text-[15px] font-bold">Updates</h3>
      <div className="grid overflow-hidden rounded-md border border-line sm:grid-cols-2">{ALERT_TOGGLES.map((toggle) => <label key={toggle.key}
        className="flex min-h-11 cursor-pointer items-start gap-3 border-b border-line px-3.5 py-3 last:border-b-0 hover:bg-field sm:[&:nth-last-child(2):nth-child(odd)]:border-b-0 sm:odd:border-r">
        <input type="checkbox" checked={prefs[toggle.key]} onChange={(event) => setPrefs((before) => ({ ...before, [toggle.key]: event.target.checked }))}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
        <span className="min-w-0"><span className="block text-sm font-semibold">{toggle.label}</span><span className="block text-xs text-ink-3">{toggle.detail}</span></span>
      </label>)}</div>
    </section>
    <section aria-labelledby="alert-prices-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="alert-prices-title" className="flex items-center gap-1.5 text-[15px] font-bold">Price alerts
          <InfoTip label="About price alerts">Alerts use the on-chain price and pause while that price is stale.</InfoTip></h3>
        <Button size="sm" variant="ghost" disabled={alerts.length >= 20 || enabledTickers.length === 0}
          onClick={() => setAlerts((before) => [...before, { ticker: enabledTickers[0]!, direction: "above", price: "" }])}>Add alert</Button>
      </div>
      {markets.isError ? <p className="text-xs text-ink-3">Couldn&apos;t refresh markets. Showing the app&apos;s built-in list.</p> : null}
      {enabledTickers.length === 0 ? <p className="text-xs text-ink-3">No live markets for price alerts yet.</p> : null}
      {alerts.length === 0 ? <p className="rounded-md border border-dashed border-line-2 px-4 py-4 text-center text-sm text-ink-3">No price alerts yet.</p> :
        <div className="grid gap-2">{alerts.map((row, index) => <div key={index} className="grid min-w-0 grid-cols-2 items-end gap-2 rounded-md border border-line bg-field p-3 sm:grid-cols-[1fr_1fr_1.25fr_auto]">
          <label className="grid gap-1 text-xs font-semibold text-ink-2">Ticker<select aria-label={`Ticker for alert ${index + 1}`} value={row.ticker} onChange={(event) => setAlerts((before) => before.map((entry, i) => i === index ? { ...entry, ticker: event.target.value } : entry))}
            className={selectClasses}>{marketOptions.map((option) => <option key={option.ticker} value={option.ticker} disabled={option.disabled}>{option.ticker}{option.note ? ` — ${option.note}` : ""}</option>)}</select></label>
          <label className="grid gap-1 text-xs font-semibold text-ink-2">Crosses<select aria-label={`Direction for alert ${index + 1}`} value={row.direction} onChange={(event) => setAlerts((before) => before.map((entry, i) => i === index ? { ...entry, direction: event.target.value as AlertRow["direction"] } : entry))}
            className={selectClasses}><option value="above">Above</option><option value="below">Below</option></select></label>
          <label className="col-span-2 grid gap-1 text-xs font-semibold text-ink-2 sm:col-span-1">Price in USDG<input aria-label={`Price for alert ${index + 1}`} inputMode="decimal" value={row.price} onChange={(event) => setAlerts((before) => before.map((entry, i) => i === index ? { ...entry, price: event.target.value } : entry))}
            placeholder="221.50" className={`${inputClasses} px-3 py-2.5 text-[14px]`} /></label>
          <Button size="sm" variant="ghost" className="col-span-2 sm:col-span-1" onClick={() => setAlerts((before) => before.filter((_, i) => i !== index))} aria-label={`Remove alert ${index + 1}`}>Remove</Button>
        </div>)}</div>}
    </section>
    <Button className="w-full" disabled={busy || !serviceReady || health?.channels[selected] === "off"} onClick={() => void savePrefs()}>{busy ? "Saving…" : `Save ${selected === "webpush" ? "browser" : selected} alerts`}</Button>
  </div>;

  return <>
    <PageHead title="Notifications" lede="Get fills, price alerts and settlement updates." />
    <div className="flex max-w-[860px] flex-col gap-5 pb-6">
      {!configured ? <Notice tone="info" role="status">Alerts aren&apos;t available yet.</Notice> : null}
      {serviceError ? <Notice tone="warn" role="status">{serviceError}
        <Button variant="ghost" size="xs" className="mt-2" onClick={() => void notifierHealth(base!).then((state) => { setHealth(state); setServiceError(null); }).catch(() => setServiceError("Alerts are still unavailable. Try again later."))}>Try again</Button>
      </Notice> : null}
      {health?.status === "degraded" ? <Notice tone="warn">Alerts are partly down. Saved settings may not load.</Notice> : null}
      {!address ? <Panel as="section" aria-labelledby="alerts-connect-title" className="flex flex-col items-start gap-4">
        <h2 id="alerts-connect-title" className="text-[20px] font-bold">Connect a wallet to manage its alerts.</h2>
        <ConnectButton />
      </Panel> : items === null ? <Panel as="section" aria-labelledby="alerts-load-title" className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 id="alerts-load-title" className="flex items-center gap-1.5 text-[17px] font-bold">Your alert channels
            <InfoTip label="About loading your settings">Your wallet will ask you to sign a message. One signature lets you edit alerts for 30 minutes.</InfoTip></h2>
          <p className="mt-1 text-sm text-ink-2">Telegram, this browser or email.</p>
        </div>
        <Button disabled={!serviceReady || busy || !wallet.data} onClick={() => void act(refresh)}>Load my settings</Button>
      </Panel> : <Panel as="section" aria-label={`${selected} alert preferences`} className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-3">Channel
            <InfoTip label="About alert channels" align="start">One wallet signature lets you edit alerts for 30 minutes.</InfoTip></h2>
          <Button variant="ghost" size="sm" disabled={!serviceReady || busy || !wallet.data} onClick={() => void act(refresh)}>Refresh status</Button>
        </div>
        <Tabs label="Alert channel" value={selected} onChange={selectChannel} items={CHANNELS.map((channel) => {
          const off = health?.channels[channel.key] === "off";
          return {
            value: channel.key,
            // A channel the service has switched off says so on its tab, not only greyed out. It sits in the
            // label, not the badge, because a Tabs badge is hidden below `sm`.
            label: off ? <>{channel.name} <span data-slot="channel-unavailable" className="block text-[11px] font-medium">Unavailable</span></>
              : channel.name,
            badge: off ? undefined : channelStatus(preferredItem(items, channel.key)) === "On" ? "On" : undefined,
            disabled: off,
            panel: channel.key === selected ? channelForm : null,
          };
        })} />
      </Panel>}
      {message ? <Notice role="status" tone={message.tone}>{message.text}</Notice> : null}
    </div>
  </>;
}
