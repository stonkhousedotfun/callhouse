export type Rounding = "nearest" | "up" | "down";

function divRound(value: bigint, scale: bigint, round: Rounding): bigint {
  if (scale <= 1n) return value;
  const quotient = value / scale;
  const rest = value % scale;
  if (rest === 0n) return quotient;
  if (round === "down") return quotient;
  if (round === "up") return quotient + 1n;
  return rest * 2n >= scale ? quotient + 1n : quotient;
}

function grouped(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function usd(raw: bigint, decimals = 6, round: Rounding = "nearest"): string {
  const negative = raw < 0n;
  const amount = negative ? -raw : raw;
  const sign = negative ? "−" : "";
  if (amount === 0n) return "$0.00";
  const one = 10n ** BigInt(decimals);
  const places = amount * 10n >= one ? 2 : 3;
  const scale = decimals > places ? 10n ** BigInt(decimals - places) : 1n;
  let scaled = decimals > places ? divRound(amount, scale, round) : amount * 10n ** BigInt(places - decimals);
  if (scaled === 0n && round !== "down") scaled = 1n;
  let shown = places;
  if (places === 3 && scaled >= 100n) { scaled = divRound(scaled, 10n, round); shown = 2; }
  const base = 10n ** BigInt(shown);
  const whole = scaled / base;
  const fraction = (scaled % base).toString().padStart(shown, "0");
  return `${sign}$${grouped(whole)}.${fraction}`;
}

export function signedUsd(raw: bigint, decimals = 6): string {
  if (raw === 0n) return "$0.00";
  return raw > 0n ? `+${usd(raw, decimals)}` : usd(raw, decimals, "up");
}

export function pctFrom(to: bigint, from: bigint | null): string | null {
  if (from === null || from <= 0n) return null;
  const diff = to - from;
  const tenths = (diff * 1_000n * 2n + (diff >= 0n ? from : -from)) / (2n * from);
  if (tenths === 0n) return "0.0%";
  const abs = tenths < 0n ? -tenths : tenths;
  return `${tenths > 0n ? "+" : "−"}${abs / 10n}.${abs % 10n}%`;
}

const EXPIRY_CHIP = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York",
});

export function expiryName(expiry: number): string {
  const parts: Record<string, string> = {};
  for (const part of EXPIRY_CHIP.formatToParts(new Date(expiry * 1000))) parts[part.type] = part.value;
  return `${parts.weekday ?? ""} ${parts.month ?? ""} ${parts.day ?? ""}`.trim();
}

export function contractName(label: string): string {
  return label.replace(/ call$/, " Call").replace(/ put$/, " Put");
}
