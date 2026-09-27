/**
 * Block C of a vault page: the vault-level fee from chain reads, the protocol
 * fees the pool pays from /v2/config, and the fee route from the splitter's burnBps. Every figure arrives as a
 * string built from a read (vaultCopy.ts); a missing read renders "not read", never 0.
 *
 * CONTRADICTION NOTICE. A rate above its compiled ceiling cannot happen on a correct deployment, so if the reads
 * say it did, the block says so in words instead of rendering both numbers as if they agreed.
 */
import { InfoTip, Notice, Panel } from "@/components/ui";
import { NOT_READ } from "./VaultHero";

export type VaultCostsProps = {
  /** houseFeeLine / earnSkimLine output; null when either read failed. */
  vaultFeeLine: string | null;
  rateBps: number | null;
  ceilBps: number | null;
  /** High-water mark, formatted; null when not read. */
  highWaterMark: string | null;
  protocol: { label: string; value: string | null }[];
  /** feeRouteLine output; null when burnBps was not read. */
  feeRoute: string | null;
  feeDelaySentence: string | null;
};

export function rateExceedsCeiling(rateBps: number | null, ceilBps: number | null): boolean {
  return rateBps !== null && ceilBps !== null && rateBps > ceilBps;
}

export function VaultCosts({ vaultFeeLine, rateBps, ceilBps, highWaterMark, protocol, feeRoute, feeDelaySentence }: VaultCostsProps) {
  return (
    <Panel as="section" aria-label="What it costs">
      <h2 className="text-lg font-semibold">What it costs</h2>
      {rateExceedsCeiling(rateBps, ceilBps) ? (
        <Notice tone="danger" role="alert">
          The vault reports a fee above its own limit. Don&apos;t rely on either number until that is fixed.
        </Notice>
      ) : null}
      <p className="text-sm">{vaultFeeLine ?? `Vault fee: ${NOT_READ}.`}</p>
      <p className="flex items-center gap-2 text-sm text-ink-2">
        High-water mark: {highWaterMark ?? NOT_READ}
        <InfoTip label="About the high-water mark" text="The fee is only charged on gains above the vault's previous high, so a loss is never charged twice." />
      </p>
      <p className="text-sm text-ink-2">No deposit, withdrawal or management fee.</p>
      <h3 className="mt-3 text-sm font-semibold">Trading fees the vault pays</h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {protocol.map((row) => (
          <div key={row.label} className="flex justify-between gap-2">
            <dt className="text-ink-2">{row.label}</dt>
            <dd className="tabular-nums">{row.value ?? NOT_READ}</dd>
          </div>
        ))}
      </dl>
      {feeDelaySentence ? <p className="text-sm text-ink-2">{feeDelaySentence}</p> : null}
      <p className="text-sm text-ink-2">{feeRoute ?? `Fee route: ${NOT_READ}.`}</p>
    </Panel>
  );
}
