/**
 * Block F of a vault page: what can go wrong, each with its bound. Rows come from
 * the typed arrays in vaultCopy.ts (`houseRisks(cadence, ticker)`, `EARN_RISKS`); this component authors no copy.
 */
import { InfoTip, Panel } from "@/components/ui";
import type { VaultRisk } from "@/lib/v2/vaultCopy";

export function VaultRisks({ risks }: { risks: readonly VaultRisk[] }) {
  return (
    <Panel as="section" aria-label="What can go wrong">
      <h2 className="text-lg font-semibold">What can go wrong</h2>
      <dl className="space-y-2">
        {risks.map((risk) => (
          <div key={risk.term}>
            <dt className="flex items-center gap-2 font-medium">{risk.term}{risk.bound ? <InfoTip label={`About ${risk.term}`} text={risk.bound} /> : null}</dt>
            <dd className="text-sm text-ink-2">{risk.words}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
