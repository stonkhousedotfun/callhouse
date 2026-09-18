/** The browser-facing part of the notifier's v1 HTTP contract. */
export type Channel = "telegram" | "webpush" | "email";
export type AlertToggle = "strikeCross" | "expiry24h" | "expiry1h" | "settlement" | "fills" | "writerItmWarning" | "autoRoll";
export type PriceAlert = { ticker: string; above?: string; below?: string };
export type AlertPrefs = Record<AlertToggle, boolean> & { priceAlerts: PriceAlert[] };
export type Subscription = {
  id: string;
  channel: Channel;
  status: "active" | "pending" | "disabled";
  target: string | null;
  prefs: AlertPrefs;
  createdAt: number;
  verifiedAt: number | null;
  disabledAt: number | null;
  disabledReason: string | null;
};
export type NotifierHealth = {
  status: "ok" | "degraded";
  database: "ok" | "unavailable";
  channels: Record<Channel, "closed" | "open" | "half-open" | "off">;
  telegramBot: "ok" | "unknown";
};
export type Auth = { address: string; signature: string; nonce: string };
export type NotifierSession = { token: string; address: string; expiresAt: number };

export function sessionIsCurrent(session: NotifierSession | null, address: string, nowSeconds = Date.now() / 1000): session is NotifierSession {
  return session !== null && session.address.toLowerCase() === address.toLowerCase() && session.expiresAt > nowSeconds + 30;
}

export const ALERT_TOGGLES: readonly { key: AlertToggle; label: string; detail: string }[] = [
  { key: "strikeCross", label: "Strike crossed", detail: "A market moves through your option's strike." },
  { key: "expiry24h", label: "24 hours before expiry", detail: "A position is nearing its final day." },
  { key: "expiry1h", label: "One hour before expiry", detail: "A position is in its last hour." },
  { key: "settlement", label: "Settlement and payout", detail: "Settlement receipts and payouts sent to your ledger." },
  { key: "fills", label: "Order fills", detail: "A buy or sell order fills." },
  { key: "writerItmWarning", label: "Writer warning", detail: "A written option is in the money near expiry." },
  { key: "autoRoll", label: "Auto roll", detail: "A writing strategy rolls to its next series." },
];

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  strikeCross: true, expiry24h: true, expiry1h: true, settlement: true, fills: true,
  writerItmWarning: true, autoRoll: true, priceAlerts: [],
};

/** A price in USDG (six decimals) to the integer base-unit string expected by N2-01. */
export function priceToBaseUnits(value: string): string | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  return amount > 0n && amount.toString().length <= 18 ? amount.toString() : null;
}

export function baseUnitsToPrice(value: string): string {
  if (!/^\d+$/.test(value)) return "";
  const amount = BigInt(value);
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function notifierBase(): string | null {
  const raw = process.env.NEXT_PUBLIC_NOTIFIER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch { return null; }
}

export class NotifierError extends Error {
  constructor(message: string, public readonly code: string = "unavailable") { super(message); }
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(8_000), ...init,
    });
  } catch {
    throw new NotifierError("The alert service is unavailable. Your market pages still work.");
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new NotifierError(error?.message || "The alert service could not finish that request.", error?.code);
  }
  return body as T;
}

function sessionHeaders(session: NotifierSession): HeadersInit {
  return { authorization: `Bearer ${session.token}` };
}

/** The notifier consumes each challenge after one authenticated request. */
export async function signNotifierChallenge(base: string, address: string, signMessage: (message: string) => Promise<string>): Promise<Auth> {
  const challenge = await request<{ message: string; nonce: string }>(base, "/v1/challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }),
  });
  return { address, nonce: challenge.nonce, signature: await signMessage(challenge.message) };
}

/** A session is held by the settings component in memory, never browser storage. */
export async function createNotifierSession(base: string, address: string, signMessage: (message: string) => Promise<string>): Promise<NotifierSession> {
  const auth = await signNotifierChallenge(base, address, signMessage);
  return request(base, "/v1/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(auth),
  });
}

export function notifierHealth(base: string): Promise<NotifierHealth> {
  return request(base, "/health");
}

export function listSubscriptions(base: string, session: NotifierSession): Promise<{ items: Subscription[] }> {
  return request(base, `/v1/subscriptions?${new URLSearchParams({ address: session.address })}`, { headers: sessionHeaders(session) });
}

export function saveSubscription(base: string, session: NotifierSession, channel: Channel, prefs: AlertPrefs, target?: unknown): Promise<{ id: string }> {
  return request(base, "/v1/subscriptions", {
    method: "POST", headers: { ...sessionHeaders(session), "content-type": "application/json" },
    body: JSON.stringify({ address: session.address, channel, ...(target === undefined ? {} : { target }), prefs }),
  });
}

export function deleteSubscription(base: string, session: NotifierSession, id: string): Promise<{ ok: true }> {
  return request(base, `/v1/subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { ...sessionHeaders(session), "content-type": "application/json" }, body: JSON.stringify({ address: session.address }),
  });
}

export async function telegramLink(base: string, session: NotifierSession): Promise<{ deepLink: string; expiresAt: number }> {
  const response = await request<unknown>(base,
    `/v1/telegram/link?${new URLSearchParams({ address: session.address })}`, { headers: sessionHeaders(session) });
  if (!response || typeof response !== "object") throw new NotifierError("The Telegram link was invalid.", "invalid-response");
  const { deepLink, expiresAt } = response as { deepLink?: unknown; expiresAt?: unknown };
  if (typeof deepLink !== "string" || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt))
    throw new NotifierError("The Telegram link was invalid.", "invalid-response");
  let url: URL;
  try { url = new URL(deepLink); }
  catch { throw new NotifierError("The Telegram link was invalid.", "invalid-response"); }
  const token = url.searchParams.get("start");
  if (url.origin !== "https://t.me" || !/^\/[A-Za-z][A-Za-z0-9_]{4,31}$/.test(url.pathname) ||
      url.searchParams.size !== 1 || !token || !/^[A-Za-z0-9_-]{32}$/.test(token) || url.hash)
    throw new NotifierError("The Telegram link was invalid.", "invalid-response");
  return { deepLink: `https://t.me${url.pathname}?start=${token}`, expiresAt };
}

export function webPushKey(base: string): Promise<{ publicKey: string }> {
  return request(base, "/v1/webpush/key");
}

export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
