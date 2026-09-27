"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui";
import { WalletLogo } from "@/components/WalletLogo";
import { cn } from "@/lib/cn";
import { CONNECT_FAILURE_TEXT, KNOWN_WALLETS, type ConnectFailure, type KnownWallet, type WalletEntry } from "@/lib/wallets";

/**
 * The wallet picker's body, and the dialog shell it sits in. Presentational: ConnectButton owns the
 * state and the wagmi calls, so every state here can be rendered in a test.
 *
 * Layout: a bottom sheet under `sm`, a centred dialog above it. Tokens only (surface, line, ink,
 * accent, shadow-lift, the radii), so it follows the app's light and dark themes.
 */

export type PickerView =
  | { kind: "list" }
  | { kind: "connecting"; entry: WalletEntry }
  | { kind: "error"; entry: WalletEntry; failure: ConnectFailure; detail?: string };

export type WalletPickerProps = {
  view: PickerView;
  entries: readonly WalletEntry[];
  /** Still asking each connector whether its provider exists. */
  detecting: boolean;
  /** Phone or tablet: offer the in-app browser links. */
  mobile: boolean;
  /** Deep links for this page, when `mobile`. */
  deepLinks?: Record<KnownWallet, string>;
  onSelect: (entry: WalletEntry) => void;
  onCancel: () => void;
  onBack: () => void;
  titleId: string;
};

function WalletIcon({ entry, size = 28 }: { entry: Pick<WalletEntry, "icon" | "name"> & { key?: string }; size?: number }) {
  return <WalletLogo walletKey={entry.key} name={entry.name} icon={entry.icon} size={size} />;
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-text">{children}</span>;
}

export function WalletPicker(props: WalletPickerProps) {
  const { view, entries, detecting, mobile, deepLinks, onSelect, onCancel, onBack, titleId } = props;

  if (view.kind === "connecting") {
    return (
      <div className="grid justify-items-center gap-4 py-4 text-center" aria-live="polite">
        <WalletIcon entry={view.entry} size={48} />
        <div>
          <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
            Waiting for {view.entry.name}
          </h2>
          <p className="mt-1.5 text-sm leading-snug text-ink-3">Approve the connection in your wallet.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <p className="text-xs leading-snug text-ink-3">Cancel does not close the request in your wallet.</p>
      </div>
    );
  }

  if (view.kind === "error") {
    return (
      <div className="grid justify-items-center gap-4 py-4 text-center" role="alert">
        <WalletIcon entry={view.entry} size={48} />
        <div>
          <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
            {view.failure === "rejected" ? "Connection declined" : `Could not connect ${view.entry.name}`}
          </h2>
          <p className="mt-1.5 text-sm leading-snug text-ink-2">{CONNECT_FAILURE_TEXT[view.failure]}</p>
          {view.detail && view.failure === "unknown" ? (
            <p className="mt-1 text-xs leading-snug text-ink-3 [overflow-wrap:anywhere]">{view.detail}</p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back
          </Button>
          {view.failure !== "unsupported" ? (
            <Button size="sm" onClick={() => onSelect(view.entry)}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const installed = entries.filter((e) => e.installed);
  const missing = entries.filter((e) => !e.installed && e.key in KNOWN_WALLETS);
  const noWallet = !detecting && installed.length === 0;

  return (
    <div className="grid gap-4">
      <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
        Connect a wallet
      </h2>

      {installed.length > 0 ? (
        <section aria-label="Installed wallets" className="grid gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Installed</h3>
          <ul className="grid gap-1">
            {installed.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => onSelect(entry)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-2 text-left text-[15px] font-semibold text-ink hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <WalletIcon entry={entry} />
                  <span className="grow">{entry.name}</span>
                  {entry.recent ? <Tag>Recent</Tag> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detecting && installed.length === 0 ? <p className="text-sm text-ink-3">Looking for wallets…</p> : null}

      {noWallet && mobile && deepLinks ? (
        <section aria-label="Open in a wallet app" className="grid gap-2">
          <p className="text-sm leading-snug text-ink-2">No wallet in this browser. Open this page in your wallet app:</p>
          {(Object.keys(KNOWN_WALLETS) as KnownWallet[]).map((key) => (
            <Button key={key} href={deepLinks[key]} external={false} variant="ghost" className="w-full justify-start!">
              <WalletIcon entry={{ key, name: KNOWN_WALLETS[key].name }} size={22} />
              Open in {KNOWN_WALLETS[key].name}
            </Button>
          ))}
        </section>
      ) : null}

      {noWallet && !mobile ? <p className="text-sm leading-snug text-ink-2">No wallet found in this browser. Install one, then reload.</p> : null}

      {!detecting && missing.length > 0 ? (
        <section aria-label="Get a wallet" className="grid gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{installed.length > 0 ? "More wallets" : "Get a wallet"}</h3>
          <ul className="grid gap-1">
            {missing.map((entry) => (
              <li key={entry.key} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2">
                <WalletIcon entry={entry} />
                <span className="grow text-[15px] font-semibold text-ink-2">{entry.name}</span>
                <Button size="xs" variant="ghost" href={KNOWN_WALLETS[entry.key as KnownWallet].install}>
                  Install
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal shell: backdrop, focus moved in on open and back to the opener on close, Tab and Shift-Tab
 * kept inside, Esc and a backdrop click close it. Rendered into document.body, client only (the
 * picker never exists on the server: ConnectButton opens it from a click).
 */
export function WalletDialog({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onKeyDown={onKeyDown}>
      <div aria-hidden="true" className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "relative max-h-[85vh] w-full overflow-y-auto bg-surface p-5 shadow-lift ring-1 ring-line outline-none",
          "rounded-t-lg pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-[380px] sm:rounded-lg",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 grid size-8 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <span aria-hidden="true">×</span>
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
