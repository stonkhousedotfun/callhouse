/**
 * Block E of a vault page: how to get out, as ordered steps. House is request ->
 * boundary -> claim; Earn is instant when flat, otherwise queued and priced when served. The cancel rule is stated
 * with each variant because it is what differs.
 */
import { Panel } from "@/components/ui";
import { houseWindowWords } from "@/lib/v2/houseEpoch";
import { CLAIM_ZERO, EARN_QUEUE_PRICING, type Cadence } from "@/lib/v2/vaultCopy";

export type ExitStep = { title: string; body: string };

/**
 * `settlementWindowS`: the chain's `SETTLEMENT_WINDOW()` read. HouseVault.requestWithdraw and
 * cancelWithdrawRequest revert PastCutoff from `epochEnd` minus it until the roll, so neither is "any time".
 * Null while unread: the copy says "before the close" without a number rather than type the window here.
 */
export function houseExitSteps(cadence: Cadence, settlementWindowS: number | null): { steps: ExitStep[]; notes: string[] } {
  // The weekly close is the week's LAST session close (HouseVault.weekly, ExpiryCalendar.nextExpiry), which is
  // Thursday in a week whose Friday is a holiday, so the copy names the close, not the weekday.
  const close = cadence === "daily" ? "the 4:00 pm ET close" : "the week's last 4:00 pm ET close";
  const cutoff = settlementWindowS === null ? "before the close" : `until ${houseWindowWords(settlementWindowS)} before the close`;
  return {
    steps: [
      { title: "Request", body: `${cutoff[0].toUpperCase()}${cutoff.slice(1)}. Your shares wait in the vault.` },
      { title: "Close", body: `Priced at ${close}, once the closing price is final.` },
      { title: "Claim", body: "After the close, any time: your share of the USDG and the stock." },
    ],
    notes: [
      `You can cancel ${cutoff}. Requests reopen when the vault starts its next epoch.`,
      "One open request at a time.",
      CLAIM_ZERO,
    ],
  };
}

export function earnExitSteps(): { steps: ExitStep[]; notes: string[] } {
  return {
    steps: [
      { title: "No open options", body: "You're paid right away. If the lending venue can't pay it all yet, the rest waits in line." },
      { title: "Options open", body: "Waits in line and is paid, in order, once they settle." },
    ],
    notes: [
      "You can cancel any time before it's paid.",
      "First in, first out. Deposits and withdrawals share one line.",
      EARN_QUEUE_PRICING,
    ],
  };
}

export function VaultExitSteps({ steps, notes }: { steps: ExitStep[]; notes: string[] }) {
  return (
    <Panel as="section" aria-label="How to exit">
      <h2 className="text-lg font-semibold">How to exit</h2>
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className="min-w-0">
            <p className="font-medium">{i + 1} {step.title}</p>
            <p className="text-sm text-ink-2">{step.body}</p>
          </li>
        ))}
      </ol>
      <ul className="mt-2 space-y-1 text-sm text-ink-2">
        {notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </Panel>
  );
}
