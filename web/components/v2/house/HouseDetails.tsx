import type { ReactNode } from "react";

import { Disclosure, InfoTip, Row, Rows } from "@/components/ui";
import { proofHref, type ProofRow } from "@/components/v2/VaultProof";
import { NOT_READ } from "@/components/v2/VaultHero";
import type { ExitStep } from "@/components/v2/VaultExitSteps";
import type { VaultCostsProps } from "@/components/v2/VaultCosts";
import type { VaultRisk } from "@/lib/v2/vaultCopy";

const short = (value: string) => value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

function Block({ title, slot, children }: { title: string; slot: string; children: ReactNode }) {
  return <Disclosure title={title} data-slot={slot}>{children}</Disclosure>;
}

export function HouseReturnSource({ prose, tip, status }: { prose: string; tip: string; status: string }) {
  return <Block title="Where the return comes from" slot="house-return-source">
    <p className="text-ink">{prose}</p>
    <p className="flex items-center gap-1.5 text-ink-3">{status}<InfoTip label="About the return" align="start" text={tip} /></p>
  </Block>;
}

export function HouseCosts({ vaultFeeLine, highWaterMark, protocol, feeRoute, feeDelaySentence }: VaultCostsProps) {
  return <Block title="What it costs" slot="house-costs">
    <p className="text-ink">{vaultFeeLine ?? `Vault fee: ${NOT_READ}.`}</p>
    <Rows>
      <Row k="High-water mark" v={highWaterMark ?? NOT_READ}
        tip="The fee is only charged on gains above the vault's previous high, so a loss is never charged twice." />
      <Row k="Deposit, withdrawal or management fee" v="None" mono={false} />
    </Rows>
    <div className="grid gap-1.5">
      <p className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Trading fees the vault pays</p>
      <Rows>
        {protocol.map((row) => <Row key={row.label} k={row.label} v={row.value ?? NOT_READ} dense />)}
      </Rows>
    </div>
    {feeDelaySentence ? <p>{feeDelaySentence}</p> : null}
    <p>{feeRoute ?? `Fee route: ${NOT_READ}.`}</p>
  </Block>;
}

export function HouseExit({ exit, line }: { exit: { steps: ExitStep[]; notes: string[] } | null; line: string }) {
  return <Block title="How to exit" slot="house-how-to-exit">
    {exit === null ? <p className="text-ink">{line}</p> : <>
      <ol className="grid gap-3 sm:grid-cols-3">
        {exit.steps.map((step, index) => <li key={step.title} className="min-w-0 rounded-md border border-line bg-field px-3.5 py-3">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <span aria-hidden="true" className="num grid size-6 shrink-0 place-items-center rounded-pill bg-accent-soft text-[12px] font-bold text-accent-text">{index + 1}</span>
            {step.title}
          </p>
          <p className="mt-1.5 text-[13px] leading-snug">{step.body}</p>
        </li>)}
      </ol>
      <ul className="grid list-disc gap-1 pl-5 marker:text-ink-3">
        {exit.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </>}
  </Block>;
}

export function HouseRisks({ risks, fallback }: { risks: readonly VaultRisk[] | null; fallback: readonly string[] }) {
  return <Block title="What can go wrong" slot="house-risks">
    {risks === null ? fallback.map((line) => <p key={line} className="text-ink">{line}</p>)
      : <dl className="grid gap-3">
        {risks.map((risk) => <div key={risk.term} className="min-w-0">
          <dt className="flex items-center gap-1.5 font-semibold text-ink">{risk.term}
            {risk.bound ? <InfoTip label={`About ${risk.term}`} align="start" text={risk.bound} /> : null}</dt>
          <dd className="mt-0.5">{risk.words}</dd>
        </div>)}
      </dl>}
  </Block>;
}

export function HouseOnChain({ rows }: { rows: readonly ProofRow[] }) {
  return <Block title="On chain" slot="house-on-chain">
    <Rows>
      {rows.map((row) => {
        const href = proofHref(row);
        return <Row key={row.label} k={row.label} v={<span className="grid justify-items-end gap-0.5">
          {href ? <a href={href} target="_blank" rel="noreferrer" title={row.value ?? undefined}
            className="text-ink underline decoration-line-2 underline-offset-2 hover:decoration-ink">{short(row.value!)}</a> : NOT_READ}
          {row.note ? <span className="font-body text-[12px] text-ink-3">{row.note}</span> : null}
        </span>} />;
      })}
    </Rows>
  </Block>;
}
