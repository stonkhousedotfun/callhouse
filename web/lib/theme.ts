/**
 * Night / day mode.
 *
 * THE RULES:
 *   - Tokens live on :root[data-theme="night"] and :root[data-theme="day"] (app/globals.css).
 *   - With nothing stored, the mode follows the phone or computer (`prefers-color-scheme`): dark -> night, light -> day.
 *   - The toggle's choice is stored in localStorage under `stonkhouse-theme` and wins from then on.
 *   - Every storage read and write is wrapped: a private window, blocked site data or a quota error falls back to the
 *     system setting instead of throwing, and a failed write never stops the page switching.
 *   - An inline <head> script sets data-theme before first paint, so there is no flash of the wrong mode.
 *
 * WHY THE SCRIPT IS BUILT FROM THIS FILE. The pre-paint script cannot import anything (it runs before the bundle), so
 * it is a string. It is generated here from the same key and the same two values the React side uses, and
 * theme.test.ts EXECUTES it against a fake document to prove it agrees with {resolveTheme}; a hand-written copy in
 * layout.tsx would be a second implementation nothing checks.
 */

export const THEME_STORAGE_KEY = "stonkhouse-theme";
export const THEMES = ["night", "day"] as const;
export type Theme = (typeof THEMES)[number];

/** A stored value is a theme only if it is exactly one of the two names; anything else is "nothing stored". */
export function parseTheme(value: unknown): Theme | null {
  return value === "night" || value === "day" ? value : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // accessing localStorage itself can throw (blocked site data)
  }
}

/** The stored choice, or null when none is stored or storage cannot be read. Never throws. */
export function readStoredTheme(storage: StorageLike | null = defaultStorage()): Theme | null {
  if (!storage) return null;
  try {
    return parseTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Persist the choice. Returns false when storage refused it; the caller still switches the page. Never throws. */
export function storeTheme(theme: Theme, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

/** Stored choice first; otherwise the system setting. */
export function resolveTheme(stored: Theme | null, systemPrefersDark: boolean): Theme {
  return stored ?? (systemPrefersDark ? "night" : "day");
}

export function otherTheme(theme: Theme): Theme {
  return theme === "night" ? "day" : "night";
}

/** The toggle names the mode it switches TO. */
export function toggleLabel(current: Theme): string {
  return current === "night" ? "Switch to day mode" : "Switch to night mode";
}

/**
 * The inline <head> script. Same key, same two values, same precedence as {readStoredTheme} + {resolveTheme}; any
 * failure (storage or matchMedia) falls through to the system setting and, failing that, leaves the attribute unset so
 * the CSS `prefers-color-scheme` fallback decides. Kept small: it blocks first paint.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement,t=null;try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="night"||s==="day")t=s}catch(e){}if(!t){try{t=window.matchMedia("(prefers-color-scheme: dark)").matches?"night":"day"}catch(e){}}if(t)d.setAttribute("data-theme",t)})();`;

/** Apply a mode to the document and persist it. The page switches even when storage refuses the write. */
export function applyTheme(theme: Theme, root: { setAttribute(name: string, value: string): void } | null =
  typeof document === "undefined" ? null : document.documentElement, storage: StorageLike | null = defaultStorage()): boolean {
  root?.setAttribute("data-theme", theme);
  return storeTheme(theme, storage);
}

/*//////////////////////////////////////////////////////////////
             CONTRAST (WCAG 2.x), for the globals.css CONTRAST note and its test
//////////////////////////////////////////////////////////////*/

/** Relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const channel = (i: number) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Contrast ratio between two #rrggbb colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
