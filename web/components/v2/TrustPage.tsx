"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { getAddress } from "viem";

import { Button, ExternalLink, InfoTip, Notice, PageHead, Panel, Table } from "@/components/ui";
import { TableOrCards } from "@/components/v2/RecordCards";
import { addressUrl } from "@/lib/chain";
import { adminSafeActsImmediately, formatDelay, roleScopeNote } from "@/lib/v2/adminDelays";
import type { ConfigResponse, PendingAdminOperation } from "@/lib/v2/api-types";
import { useConfig } from "@/lib/v2/hooks";
import { Time } from "@/components/ui/Time";

type TrustConfig = Pick<ConfigResponse, "contracts" | "safes" | "access" | "pendingOperations">;

function displayName(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function ExplorerAddress({ address }: { address: string }) {
  const checksummed = getAddress(address);
  return <ExternalLink href={addressUrl(checksummed)} className="link num [overflow-wrap:anywhere]">
    {checksummed}
  </ExternalLink>;
}

function TrustIntro() {
  return <PageHead
    eyebrow="Trust"
    title="Protocol control, in public."
    lede="Control addresses, role delays and scheduled operations."
    aside={<div className="flex flex-wrap gap-x-4 gap-y-1">
      <Link href="/trust/markets" className="link font-semibold">Market status</Link>
      <Link href="/trust/burns" className="link font-semibold">Token burns</Link>
    </div>}
  />;
}

/**
 * At a zero-delay launch the Admin Safe's calls execute directly: AccessManager schedules nothing at a delay
 * of 0, so there is no scheduled operation for the guardian to cancel until the admin's lock transaction raises the
 * delays. The guardian sentence stays (it is true again after the lock); this line says what is true now, and only when
 * the Safe's holder delay reads 0 on every one of role ids 0-5 (adminDelays.adminSafeActsImmediately).
 */
export const ADMIN_SAFE_IMMEDIATE =
  "The Admin Safe's changes currently take effect immediately, with no scheduled notice.";

function TrustFacts({ data }: { data?: Pick<ConfigResponse, "access" | "safes"> }) {
  return <>
    <Panel as="section">
      {/* Source: callhouse-contracts src/v2/access/V8Roles.sol. */}
      <h2 className="flex items-center gap-2 font-display text-xl font-bold">
        Guardian powers and limits
        <InfoTip label="About the guardian">
          The guardian can pause minting and series creation, pause trading, veto or unveto a settlement,
          clear a payout route, and cancel scheduled fee, market-fee, configuration, treasury, and listing operations.
        </InfoTip>
      </h2>
      <p className="mt-2 text-sm font-semibold text-ink">
        The guardian cannot cancel ADMIN-lane operations, including role grants and selector mappings.
      </p>
      {adminSafeActsImmediately(data) ? <p className="mt-2 text-sm text-ink" data-slot="admin-immediate">{ADMIN_SAFE_IMMEDIATE}</p> : null}
    </Panel>
  </>;
}

function TrustShell({ children, data }: { children: ReactNode; data?: Pick<ConfigResponse, "access" | "safes"> }) {
  return <>
    <TrustIntro />
    <TrustFacts data={data} />
    {children}
  </>;
}

function SafeAddresses({ safes }: { safes: TrustConfig["safes"] }) {
  return <Panel as="section" className="mt-6">
    <h2 className="font-display text-xl font-bold">Safes</h2>
    {!safes ? <p className="mt-2 text-sm text-ink-2">Safe addresses are not published yet.</p> :
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        {(["admin", "treasury"] as const).map((name) => <div key={name}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">{displayName(name)} Safe</dt>
          <dd className="mt-1 text-sm">
            {safes[name] ? <ExplorerAddress address={safes[name]} /> :
              <span className="text-ink-2">Not published yet.</span>}
          </dd>
        </div>)}
      </dl>}
  </Panel>;
}

function AccessRoles({ access }: { access: TrustConfig["access"] }) {
  return <Panel as="section" className="mt-6">
    <h2 className="font-display text-xl font-bold">Access roles</h2>
    {!access ? <p className="mt-2 text-sm text-ink-2">Role and holder data are not published yet.</p> : <>
      <p className="mt-2 text-sm text-ink-2">
        Access manager: <ExplorerAddress address={access.manager} />
      </p>
      {access.roles.length === 0 ?
        <p className="mt-4 text-sm text-ink-2">No roles are published yet.</p> :
        <TableOrCards cardsLabel="Protocol access roles and holders" className="mt-5"
          cards={access.roles.map((role) => ({
            id: `${role.id}-${role.name}`,
            title: role.name,
            subtitle: `Role ID ${role.id}`,
            // All four columns. The holder list is `wide` because it is a list, not a figure.
            fields: [
              { label: "Role delay", value: formatDelay(role.delayS) },
              // NEW_LISTING's "No delay" is the design, and what it cannot do is the point.
              ...(roleScopeNote(role.id) === null ? [] : [{ label: "Scope", wide: true, value: <span data-slot="role-scope">{roleScopeNote(role.id)}</span> }]),
              { label: "Holders", wide: true, value: role.holders.length === 0
                ? <span className="text-ink-2">No holders published.</span>
                : <ul className="space-y-2 font-sans font-normal">{role.holders.map((holder, index) =>
                  <li key={`${holder.address}-${holder.delayS}-${index}`}>
                    <ExplorerAddress address={holder.address} />
                    <span className="ml-1 text-ink-2">· {formatDelay(holder.delayS)} holder delay</span>
                  </li>)}</ul> },
            ],
          }))}>
          <Table label="Protocol access roles and holders" minWidth={760}>
          <thead><tr><th scope="col">Role</th><th scope="col">ID</th><th scope="col">Role delay</th><th scope="col">Holders</th></tr></thead>
          <tbody>{access.roles.map((role) => <tr key={`${role.id}-${role.name}`}>
            <td className="!whitespace-normal font-sans font-semibold">
              {role.name}
              {roleScopeNote(role.id) === null ? null :
                <p className="mt-1 text-xs font-normal text-ink-2" data-slot="role-scope">{roleScopeNote(role.id)}</p>}
            </td>
            <td>{role.id}</td>
            <td>{formatDelay(role.delayS)}</td>
            <td className="!whitespace-normal text-left">
              {role.holders.length === 0 ? <span className="text-ink-2">No holders published.</span> :
                <ul className="space-y-2">{role.holders.map((holder, index) => <li key={`${holder.address}-${holder.delayS}-${index}`}>
                  <ExplorerAddress address={holder.address} />
                  <span className="ml-1 text-ink-2">· {formatDelay(holder.delayS)} holder delay</span>
                </li>)}</ul>}
            </td>
          </tr>)}</tbody>
          </Table>
        </TableOrCards>}
    </>}
  </Panel>;
}

function operationLabel(operation: PendingAdminOperation): string {
  return operation.label.trim() || `${operation.target} ${operation.selector}`;
}

function PendingOperations({ operations }: { operations: TrustConfig["pendingOperations"] }) {
  return <Panel as="section" className="mt-6">
    <h2 className="font-display text-xl font-bold">Pending operations</h2>
    {operations === undefined ?
      <p className="mt-2 text-sm text-ink-2">Pending operations are not published yet.</p> :
      operations.length === 0 ?
        <p className="mt-2 text-sm text-ink-2">No pending administrative operations are scheduled.</p> :
        <ul className="mt-4 space-y-3 text-sm">{operations.map((operation) => {
          return <li key={operation.key} className="border-t border-line pt-3 first:border-0 first:pt-0">
            <strong>{operationLabel(operation)}</strong>
            <span className="text-ink-2"> — ready no earlier than </span>
            <Time at={operation.readyAt} />
          </li>;
        })}</ul>}
  </Panel>;
}

function ContractAddresses({ contracts }: { contracts: ConfigResponse["contracts"] }) {
  const { sources, ...core } = contracts;
  const entries = [
    ...Object.entries(core).map(([name, address]) => ({ name: displayName(name), address })),
    ...Object.entries(sources).map(([name, address]) => ({ name: `${displayName(name)} source`, address })),
  ];

  return <Panel as="section" className="mt-6">
    <h2 className="font-display text-xl font-bold">Contracts</h2>
    <dl className="mt-4 divide-y divide-line">
      {entries.map(({ name, address }) => <div key={name} className="grid gap-1 py-3 first:pt-0 sm:grid-cols-[minmax(9rem,0.45fr)_minmax(0,1fr)] sm:gap-4">
        <dt className="font-semibold">{name}</dt>
        <dd className="text-sm sm:text-right">
          {address ? <ExplorerAddress address={address} /> : <span className="text-ink-2">Not published yet.</span>}
        </dd>
      </div>)}
    </dl>
  </Panel>;
}

export function TrustPageView({ data, stale = false }: { data: TrustConfig; stale?: boolean }) {
  return <TrustShell data={data}>
    {stale ? <Notice tone="warn" role="status" className="mt-6">
      Showing saved data while live updates reconnect.
    </Notice> : null}
    <SafeAddresses safes={data.safes} />
    <AccessRoles access={data.access} />
    <PendingOperations operations={data.pendingOperations} />
    <ContractAddresses contracts={data.contracts} />
  </TrustShell>;
}

export function TrustPage() {
  const config = useConfig();

  if (config.data) return <TrustPageView data={config.data} stale={config.isError} />;

  return <TrustShell>
    {config.isPending ? <Panel role="status" aria-label="Loading trust data" className="mt-6 animate-pulse">
      <div className="h-5 w-40 rounded bg-surface-2" />
      <div className="mt-4 h-4 w-full rounded bg-surface-2" />
      <span className="sr-only">Loading trust data</span>
    </Panel> : <Notice tone="warn" role="status" title="Trust data is unavailable." className="mt-6">
      <Button size="xs" variant="ghost" className="mt-3" onClick={() => void config.refetch()}>Try again</Button>
    </Notice>}
  </TrustShell>;
}
