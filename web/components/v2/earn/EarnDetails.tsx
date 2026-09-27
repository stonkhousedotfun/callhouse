import { InfoTip, Row, Rows } from "@/components/ui";
import { proofHref, type ProofRow } from "@/components/v2/VaultProof";
import type { ExitStep } from "@/components/v2/VaultExitSteps";
import type { VaultCostsProps } from "@/components/v2/VaultCosts";
import { NOT_READ } from "@/components/v2/VaultHero";
import type { VaultRisk } from "@/lib/v2/vaultCopy";

const H3 = "font-display text-[15px] font-bold text-ink";

export function EarnReturnBlock({ premiumLine, venueLine, noRateYet }: { premiumLine: string; venueLine: string | null; noRateYet: string }) {
  return <section aria-label="Where the return comes from" className="grid gap-2">
    <p className="text-ink">{premiumLine}</p>
    {venueLine ? <p>{venueLine}</p> : null}
    <p className="text-ink-3">{noRateYet}</p>
  </section>;
}

export function EarnCostsBlock({ vaultFeeLine, highWaterMark, protocol, feeRoute, feeDelaySentence }: VaultCostsProps) {
  return <section aria-label="What it costs" className="grid gap-3">
    <div className="grid gap-1">
      <p className="text-ink">{vaultFeeLine ?? `Vault fee: ${NOT_READ}.`}</p>
      <p>No deposit, withdrawal or management fee.</p>
    </div>
    <Rows>
      <Row k="High-water mark" v={highWaterMark ?? NOT_READ}
        tip="The fee is only charged on gains above the vault's previous high, so a loss is never charged twice." />
    </Rows>
    <div className="grid gap-1">
      <h3 className={H3}>Trading fees the vault pays</h3>
      <Rows>
        {protocol.map((row) => <Row key={row.label} k={row.label} v={row.value ?? NOT_READ} />)}
      </Rows>
    </div>
    {feeDelaySentence ? <p>{feeDelaySentence}</p> : null}
    <p>{feeRoute ?? `Fee route: ${NOT_READ}.`}</p>
  </section>;
}

export function EarnExitBlock({ steps, notes }: { steps: ExitStep[]; notes: string[] }) {
  return <section aria-label="How to exit" className="grid gap-4">
    <ol className="grid gap-3 sm:grid-cols-2">
      {steps.map((step, i) => <li key={step.title} className="flex min-w-0 gap-3 rounded-md border border-line bg-field p-3.5">
        <span aria-hidden="true" className="num grid size-6 shrink-0 place-items-center rounded-pill bg-accent-soft text-[12px] font-bold text-accent-text">{i + 1}</span>
        <span className="min-w-0">
          <span className="block font-semibold text-ink">{step.title}</span>
          <span className="mt-0.5 block text-[13.5px]">{step.body}</span>
        </span>
      </li>)}
    </ol>
    <ul className="grid gap-1.5 pl-1">
      {notes.map((note) => <li key={note} className="flex gap-2.5"><span aria-hidden="true" className="mt-[9px] size-1 shrink-0 rounded-pill bg-ink-3" />{note}</li>)}
    </ul>
  </section>;
}

export function EarnRisksBlock({ risks }: { risks: readonly VaultRisk[] }) {
  return <section aria-label="What can go wrong">
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {risks.map((risk) => <div key={risk.term} className="min-w-0">
        <dt className="flex items-center gap-1.5 font-semibold text-ink">{risk.term}
          {risk.bound ? <InfoTip label={`About ${risk.term}`} align="start" text={risk.bound} /> : null}</dt>
        <dd className="mt-0.5 text-[13.5px]">{risk.words}</dd>
      </div>)}
    </dl>
  </section>;
}

export function EarnProofBlock({ rows }: { rows: ProofRow[] }) {
  return <section aria-label="On chain">
    <Rows>
      {rows.map((row) => {
        const href = proofHref(row);
        return <Row key={row.label} k={row.label} v={<>
          {href ? <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line-2 underline-offset-2 hover:decoration-ink">{row.value}</a> : NOT_READ}
          {row.note ? <span className="ml-2 font-sans text-ink-3">{row.note}</span> : null}
        </>} />;
      })}
    </Rows>
  </section>;
}

export function EarnHistoryBlock({ text }: { text: string }) {
  return <section aria-label="History" className="grid gap-1">
    <h3 className={H3}>History</h3>
    <p>{text}</p>
  </section>;
}
