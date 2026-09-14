"use client";

/**
 * Toasts, and the one runner every form sends its transactions through.
 *
 * A revert is surfaced by name on purpose: the vault ABI carries every custom error, including
 * the ones raised inside its linked libraries, so viem decodes `UseQueue()` or
 * `PremiumBelowFloorAtFill(...)` instead of leaving a bare selector on screen. Those names are the
 * product rules, and lib/revert.ts translates the ones a depositor or a buyer can actually hit.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Hex } from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { txUrl } from "@/lib/chain";
import { shortHash } from "@/lib/format";
import { decodeRevertData, explainRevert } from "@/lib/revert";

export type ToastTone = "pending" | "success" | "error";

export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  hash?: Hex;
};

type ToastContextValue = {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  update: (id: number, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Turn any failure into a sentence a human can act on.
 *
 * viem decodes a revert against the ABI the call was made with; a vault error surfacing through a
 * Seaport call (the fill hooks) is not in Seaport's ABI, so the raw data is decoded again here
 * against the vault's merged ABI (lib/revert.ts) before falling back to viem's own message.
 */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Rejected in wallet.";
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return explainRevert(name, (reverted.data?.args ?? []) as readonly unknown[]);
      const decoded = decodeRevertData(reverted.raw);
      if (decoded?.name) return decoded.text;
      return reverted.shortMessage || "Reverted.";
    }
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);

  const update = useCallback((id: number, patch: Partial<Omit<Toast, "id">>) => {
    setToasts((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ toasts, push, update, dismiss }), [toasts, push, update, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost />
    </ToastContext.Provider>
  );
}

function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider is missing above this component");
  return ctx;
}

function ToastHost() {
  const { toasts, dismiss } = useToastContext();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          <div className="toast-title">
            <span>{t.title}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
          {t.body ? <div className="toast-body">{t.body}</div> : null}
          {t.hash ? (
            <div className="toast-body">
              <a href={txUrl(t.hash)} target="_blank" rel="noreferrer noopener">
                {shortHash(t.hash)} ↗
              </a>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export type TxRun = {
  /** Shown while the wallet is open and while the tx is in flight. */
  pending: string;
  /** Shown once the receipt says status === "success". */
  success: string;
};

/**
 * Run one transaction with a toast for every stage, and a Blockscout link as soon as there is a
 * hash. Returns the hash on success, or null if anything went wrong — callers use that to decide
 * whether to move to the next step of a two-step flow (approve → deposit).
 */
export function useTxRunner() {
  const { push, update, dismiss } = useToastContext();
  const config = useConfig();

  return useCallback(
    async (send: () => Promise<Hex>, labels: TxRun): Promise<Hex | null> => {
      const id = push({ tone: "pending", title: labels.pending, body: "Confirm in your wallet." });
      try {
        const hash = await send();
        update(id, { body: "Waiting for the chain…", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status === "reverted") {
          update(id, { tone: "error", title: "Transaction reverted", body: undefined, hash });
          return null;
        }
        update(id, { tone: "success", title: labels.success, body: undefined, hash });
        setTimeout(() => dismiss(id), 9000);
        return hash;
      } catch (err) {
        update(id, { tone: "error", title: "Failed", body: describeError(err) });
        return null;
      }
    },
    [push, update, dismiss, config],
  );
}

/** Fire-and-forget notice, for things that are not transactions (copy to clipboard, API errors). */
export function useNotice() {
  const { push, dismiss } = useToastContext();
  return useCallback(
    (tone: ToastTone, title: string, body?: string) => {
      const id = push({ tone, title, body });
      setTimeout(() => dismiss(id), 5000);
    },
    [push, dismiss],
  );
}
