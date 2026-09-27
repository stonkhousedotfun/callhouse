/**
 * Block H of a vault page: every claim on the page links to its source. Links go
 * through lib/chain.ts's `addressUrl` / `txUrl` / `tokenUrl`; a row whose address was not read says "not read" and
 * has no link rather than linking to a guess.
 */
import { Panel } from "@/components/ui";
import { addressUrl, tokenUrl, txUrl } from "@/lib/chain";
import { NOT_READ } from "./VaultHero";

export type ProofRow = { label: string; kind: "address" | "token" | "tx"; value: string | null; note?: string | null };

export function proofHref(row: ProofRow): string | null {
  if (row.value === null) return null;
  return row.kind === "tx" ? txUrl(row.value) : row.kind === "token" ? tokenUrl(row.value) : addressUrl(row.value);
}

export function VaultProof({ rows }: { rows: ProofRow[] }) {
  return (
    <Panel as="section" aria-label="On chain">
      <h2 className="text-lg font-semibold">On chain</h2>
      <dl className="space-y-1 text-sm">
        {rows.map((row) => {
          const href = proofHref(row);
          return (
            <div key={row.label} className="flex flex-wrap gap-x-3">
              <dt className="w-32 shrink-0 text-ink-2">{row.label}</dt>
              <dd className="min-w-0 break-all font-mono">
                {href ? <a href={href} target="_blank" rel="noreferrer" className="underline">{row.value}</a> : NOT_READ}
                {row.note ? <span className="ml-2 font-sans text-ink-3">{row.note}</span> : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </Panel>
  );
}
