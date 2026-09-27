/**
 * When a "?" InfoTip shows its explanation: a "?" icon a reader can hover
 * over, which explains itself after more than 1 second. Pure and timer-injected, so the
 * rules run under vitest's node environment without a DOM; components/ui/InfoTip.tsx wires the DOM events to it.
 *
 *   hover     a mouse or pen resting on the icon opens it after INFO_TIP_DELAY_MS. Leaving first cancels; leaving
 *             after it opened closes it, unless a tap or the keyboard opened it.
 *   tap       a press (touch, or a click) toggles it at once. Touch never starts the hover timer: a finger does not
 *             hover, and a browser's emulated mouseenter on tap must not open it a second later.
 *   keyboard  focus from the keyboard opens it at once. Focus that came with a pointer press does not, or the click
 *             that follows would toggle it straight back shut.
 *   close     Escape and blur close it, and cancel a pending hover.
 */

export const INFO_TIP_DELAY_MS = 1000;

export type InfoTipTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const WALL_CLOCK: InfoTipTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Why it is open. Only a hover-opened tip closes when the pointer leaves. */
export type InfoTipOpenReason = "hover" | "press" | "keyboard";

export type InfoTipController = {
  pointerEnter(pointerType: string): void;
  pointerLeave(pointerType: string): void;
  press(): void;
  focus(fromKeyboard: boolean): void;
  blur(): void;
  escape(): void;
  dispose(): void;
  isOpen(): boolean;
};

export function createInfoTipController(
  onChange: (open: boolean) => void,
  timers: InfoTipTimers = WALL_CLOCK,
  delayMs: number = INFO_TIP_DELAY_MS,
): InfoTipController {
  let reason: InfoTipOpenReason | null = null;
  let pending: unknown = null;

  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const open = (why: InfoTipOpenReason) => {
    cancel();
    const was = reason !== null;
    reason = why;
    if (!was) onChange(true);
  };
  const close = () => {
    cancel();
    if (reason === null) return;
    reason = null;
    onChange(false);
  };

  return {
    pointerEnter(pointerType) {
      if (pointerType === "touch" || reason !== null || pending !== null) return;
      pending = timers.set(() => {
        pending = null;
        open("hover");
      }, delayMs);
    },
    pointerLeave(pointerType) {
      if (pointerType === "touch") return;
      cancel();
      if (reason === "hover") close();
    },
    press() {
      if (reason !== null) close();
      else open("press");
    },
    focus(fromKeyboard) {
      if (fromKeyboard) open("keyboard");
    },
    blur: close,
    escape: close,
    dispose: cancel,
    isOpen: () => reason !== null,
  };
}
