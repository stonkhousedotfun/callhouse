"use client";

/**
 * The night/day toggle: a sun/moon icon button, at least
 * 44px square, whose aria-label names the mode it switches TO. Mounting it in the header is the header's job; this file
 * exports it ready.
 *
 * THE DOCUMENT IS THE SOURCE OF TRUTH, not React state. The pre-paint script (lib/theme.ts THEME_INIT_SCRIPT) has
 * already set data-theme before this component exists, so the toggle reads the attribute after hydration instead of
 * guessing, and renders the neutral "night" label on the server (where there is no document). Before mount the button
 * is still a working button; it simply has not read the page yet. It subscribes to the attribute itself
 * (useSyncExternalStore + MutationObserver), so a toggle anywhere on the page updates every toggle.
 */
import { useSyncExternalStore } from "react";

import { applyTheme, otherTheme, parseTheme, resolveTheme, toggleLabel, type Theme } from "@/lib/theme";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "night";
  const fromDom = parseTheme(document.documentElement.getAttribute("data-theme"));
  if (fromDom) return fromDom;
  let dark = false;
  try { dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { /* no matchMedia: day */ }
  return resolveTheme(null, dark);
}

export function SunIcon() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>;
}

export function MoonIcon() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>;
}

/** Presentational half, testable without a document: the icon shows the mode you switch TO. */
export function ThemeToggleButton({ theme, onToggle, className = "" }: { theme: Theme; onToggle: () => void; className?: string }) {
  return <button type="button" onClick={onToggle} aria-label={toggleLabel(theme)} title={toggleLabel(theme)}
    data-theme-toggle={theme}
    className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-line-2 text-ink-2 hover:text-ink ${className}`.trim()}>
    {theme === "night" ? <SunIcon /> : <MoonIcon />}
  </button>;
}

/** Re-render when data-theme changes on <html> (applyTheme sets it, from this toggle or any other). */
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const SERVER_THEME = (): Theme => "night";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, SERVER_THEME);
  return <ThemeToggleButton theme={theme} className={className} onToggle={() => {
    applyTheme(otherTheme(currentTheme())); // switches the page even if storage refuses the write; the observer re-renders
  }} />;
}
