"use client";

import { Notice } from "@/components/ui";
import type { PendingAdminOperation } from "@/lib/v2/api-types";
import { useConfig } from "@/lib/v2/hooks";

export type PendingOperationsNoticeProps = {
  className?: string;
};

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

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

  return <Notice tone="info" role="status" title={operations.length === 1
    ? "Admin operation scheduled"
    : "Admin operations scheduled"} className={className}>
    <p>These protocol changes cannot execute before the times shown.</p>
    <ul className="mt-1 space-y-1">
      {operations.map(({ operation, when }) => <li key={operation.key}>
        <strong className="font-semibold text-ink">{operationLabel(operation)}</strong>: ready <time
          dateTime={when.toISOString()}>{EASTERN.format(when)}</time>.
      </li>)}
    </ul>
  </Notice>;
}
