"use client";

import { InfoTip, Notice } from "@/components/ui";
import { Time } from "@/components/ui/Time";
import type { PendingAdminOperation } from "@/lib/v2/api-types";
import { useConfig } from "@/lib/v2/hooks";

export type PendingOperationsNoticeProps = {
  className?: string;
};

function operationLabel(operation: PendingAdminOperation): string {
  return operation.label.trim() || `${operation.target} ${operation.selector}`;
}

export function PendingOperationsNotice({ className }: PendingOperationsNoticeProps) {
  const config = useConfig();
  const operations = (config.data?.pendingOperations ?? []).flatMap((operation) => {
    if (!Number.isSafeInteger(operation.readyAt) || operation.readyAt <= 0) return [];
    const when = new Date(operation.readyAt * 1000);
    if (Number.isNaN(when.getTime())) return [];
    return [{ operation, when }];
  });

  if (!operations.length) return null;

  return <Notice tone="info" role="status" title={<>{operations.length === 1
    ? "Admin change scheduled"
    : "Admin changes scheduled"} <InfoTip label="About scheduled changes">Each change can run from the time
    shown, not before.</InfoTip></>} className={className}>
    <ul className="space-y-1">
      {operations.map(({ operation }) => <li key={operation.key}>
        <strong className="font-semibold text-ink">{operationLabel(operation)}</strong>: ready <Time at={operation.readyAt} />.
      </li>)}
    </ul>
  </Notice>;
}
