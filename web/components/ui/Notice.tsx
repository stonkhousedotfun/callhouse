import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { CheckCircleIcon, InfoIcon, StopIcon, WarnIcon } from "./icons";

/**
 * A notice: an icon, an optional bold heading, and the body. Grown from callhouse-site's
 * components/ui/Notice.tsx (the warn box) into the four tones the app needs:
 *
 *   warn    warn-soft ground, triangle   — a real risk or a closed door ("Deposits are closed")
 *   danger  danger at 10%, octagon       — refused, broken or stranded ("A claim is stranded")
 *   info    usdg-soft ground, "i"        — how the thing works right now ("A call is open")
 *   accent  accent-soft ground, check    — it worked ("Simulation passed")
 *
 * `variant="plain"` drops the ground and keeps the icon beside running text (the site's .disclose).
 *
 * `title` renders as a <strong> on its own line. The body is a <div>, so it may hold a list.
 *
 * Copy that disclosure policy (copy-lint enforced this until it was removed on 2026-09-21; nothing checks it now) requires on a page (e.g. "Premium is paid only if a buyer fills" on
 * app/vault/nvda/page.tsx) must be written in that page file as children or title, never as a
 * default inside this component: the linter reads the page file's source text.
 *
 * TEST HOOK: `data-slot="notice"` on the box. The W-13 run finds notices by it and reads the
 * heading as the box's <strong>.
 */
export type NoticeTone = "warn" | "danger" | "info" | "accent";

export type NoticeProps = {
  tone?: NoticeTone;
  variant?: "box" | "plain";
  title?: ReactNode;
  /** Live region for a notice that appears in response to typing (an over-balance amount). */
  role?: "status" | "alert";
  className?: string;
  children?: ReactNode;
};

const GROUND: Record<NoticeTone, string> = {
  warn: "bg-warn-soft",
  danger: "bg-danger/10",
  info: "bg-usdg-soft",
  accent: "bg-accent-soft",
};

const ICON_TONE: Record<NoticeTone, string> = {
  warn: "text-warn",
  danger: "text-danger",
  info: "text-usdg",
  accent: "text-accent-text",
};

function ToneIcon({ tone, className }: { tone: NoticeTone; className?: string }) {
  switch (tone) {
    case "danger":
      return <StopIcon className={className} />;
    case "info":
      return <InfoIcon className={className} />;
    case "accent":
      return <CheckCircleIcon size={16} className={className} />;
    default:
      return <WarnIcon className={className} />;
  }
}

export function Notice({ tone = "warn", variant = "box", title, role, className, children }: NoticeProps) {
  const box = variant === "box";
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      role={role}
      className={cn(
        "flex min-w-0 items-start gap-2.5 text-ink-2",
        box ? cn("rounded-xl px-3.5 py-3 text-[13.5px] leading-[1.5]", GROUND[tone]) : "text-sm",
        className,
      )}
    >
      <ToneIcon tone={tone} className={cn("mt-[3px] shrink-0", ICON_TONE[tone])} />
      <div className="min-w-0 flex-1">
        {title ? <strong className="block font-semibold text-ink">{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}
