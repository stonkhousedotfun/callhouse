/**
 * Block A of a vault page: value, TVL, your position, and the boundary or queue
 * state. Shared by House and Earn.
 *
 * THE LABEL IS PART OF THE VALUE. A `LabelledValue` cannot be constructed without its label, so a mark or an
 * indicative figure cannot be rendered bare by a later edit: the type refuses it, and VaultHero.test.ts asserts the
 * label text is in the markup beside the number. A value that was not read renders "not read", never 0.
 *
 * NEON: the value and TVL are headline numbers, heavy sans at 30px; the cell headings are
 * the spec's uppercase captions (12px, 600, 0.08em).
 */
import { Panel } from "@/components/ui";
import type { LabelledValue } from "@/lib/v2/vaultCopy";

export type { LabelledValue };

export type VaultHeroProps = {
  title: string;
  value: LabelledValue;
  tvl: LabelledValue;
  position: { shares: string | null; valueAtMark: LabelledValue | null; queued: string | null } | null;
  /** House: the next boundary. */
  boundary?: { at: string; countdown: string; sentence: string } | null;
  /** Earn: instant or queued, and the depth. */
  queueState?: string | null;
};

export const NOT_READ = "not read";

function Cell({ heading, value }: { heading: string; value: LabelledValue }) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">{heading}</h3>
      <p className="mt-1 text-[30px] font-extrabold leading-tight tracking-[-0.03em] tabular-nums">{value.text ?? NOT_READ}</p>
      <p className={value.tone === "caution" ? "text-sm font-medium text-warn" : "text-sm text-ink-2"}>{value.label}</p>
    </div>
  );
}

export function VaultHero({ title, value, tvl, position, boundary, queueState }: VaultHeroProps) {
  return (
    <Panel as="section" aria-label={`${title} summary`}>
      <h2 className="sr-only">{title} summary</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Cell heading="Value per share" value={value} />
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Your position</h3>
          {position === null ? (
            <p className="text-sm text-ink-2">Connect a wallet to see your position.</p>
          ) : (
            <>
              <p className="mt-1 text-lg font-bold tabular-nums">{position.shares === null ? NOT_READ : `${position.shares} shares`}</p>
              {position.valueAtMark ? (
                <p className="text-sm text-ink-2">
                  ≈ {position.valueAtMark.text ?? NOT_READ} <span className={position.valueAtMark.tone === "caution" ? "text-warn" : ""}>{position.valueAtMark.label}</span>
                </p>
              ) : null}
              {position.queued ? <p className="text-sm text-ink-2">{position.queued}</p> : null}
            </>
          )}
        </div>
        {boundary ? (
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Next close</h3>
            <p className="mt-1 text-lg font-bold">{boundary.at}</p>
            <p className="text-sm text-ink-2" aria-live="off">in {boundary.countdown}</p>
            <p className="text-sm text-ink-2">{boundary.sentence}</p>
          </div>
        ) : null}
        {queueState ? (
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Deposits &amp; redemptions</h3>
            <p className="text-sm text-ink-2">{queueState}</p>
          </div>
        ) : null}
        <Cell heading="Vault total" value={tvl} />
      </div>
    </Panel>
  );
}
