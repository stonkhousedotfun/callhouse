import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingAdminOperation } from "@/lib/v2/api-types";
import { useConfig } from "@/lib/v2/hooks";
import { PendingOperationsNotice } from "./PendingOperationsNotice";

vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn() }));

const readyAt = Date.UTC(2026, 8, 18, 17, 30) / 1000;
const operation: PendingAdminOperation = {
  key: `0x${"1".repeat(64)}:1`,
  id: `0x${"1".repeat(64)}`,
  role: "FEE_MANAGER_ROLE",
  target: "0x1111111111111111111111111111111111111111",
  selector: "0x12345678",
  label: "Update fee policy",
  caller: "0x2222222222222222222222222222222222222222",
  scheduledAt: Date.UTC(2026, 8, 16, 17, 30) / 1000,
  readyAt,
};

/**
 * The `key` of every <li> the component builds, in order.
 *
 * Calls the component as the plain function it is -- `useConfig` is mocked, so there is no hook
 * state to stand up -- and walks the returned element tree. `renderToStaticMarkup` cannot answer
 * this: keys are consumed by the renderer and never reach the markup.
 */
function listItemKeys(operations: PendingAdminOperation[]): (string | null)[] {
  vi.mocked(useConfig).mockReturnValue({
    data: { pendingOperations: operations },
  } as unknown as ReturnType<typeof useConfig>);
  const keys: (string | null)[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isValidElement(node)) return;
    if (node.type === "li") keys.push(node.key);
    visit((node.props as { children?: unknown }).children);
  };
  visit(PendingOperationsNotice({}));
  return keys;
}

function renderOperations(operations: PendingAdminOperation[] | undefined) {
  vi.mocked(useConfig).mockReturnValue({
    data: operations === undefined ? undefined : { pendingOperations: operations },
  } as unknown as ReturnType<typeof useConfig>);
  return renderToStaticMarkup(createElement(PendingOperationsNotice));
}

afterEach(() => vi.clearAllMocks());

describe("pending admin operations notice", () => {
  it("shows every operation at its API ready time in New York", () => {
    const later = { ...operation, key: `0x${"2".repeat(64)}:1`, id: `0x${"2".repeat(64)}`,
      label: "Rotate guardian", readyAt: readyAt + 3_600 };
    const html = renderOperations([operation, later]);

    expect(html).toContain('role="status"');
    expect(html).toContain("Admin operations scheduled");
    expect(html).toContain("Update fee policy");
    expect(html).toContain("Sep 18, 2026");
    expect(html).toContain("1:30 PM EDT");
    expect(html).toContain(new Date(readyAt * 1000).toISOString());
    expect(html).toContain("Rotate guardian");
    expect(html).toContain("2:30 PM EDT");
    expect(html).not.toContain("Sep 16, 2026");
  });

  // T-434. AccessManager REUSES an operation id when the same call is rescheduled, so two live rows
  // can carry the same `id` while the indexer keys each on `operationId:nonce`. Keying this list on
  // `id` gives React two children with one key.
  //
  // READ THIS BEFORE WRITING A SIMPLER VERSION OF IT. The obvious test -- render both and assert
  // both appear -- CANNOT FAIL, and that was measured, not assumed: keying the list on `id` again
  // and re-running left all five cases green. `renderToStaticMarkup` emits both <li>s whichever
  // field the key comes from, and React's static server renderer logs no duplicate-key warning
  // either, so a console.error spy is green too. Duplicate keys break reconciliation on the client,
  // and none of that is reachable from a one-shot server render.
  //
  // So this reads the KEYS THEMSELVES off the element tree. A function component called directly
  // returns React elements, and a React element carries its `key`, which is the one place the
  // distinction between `operation.key` and `operation.id` is visible from a test.
  it("gives two operations that share an operationId two distinct React keys", () => {
    const rescheduled = { ...operation, key: `${operation.id}:2`, label: "Rotate guardian",
      readyAt: readyAt + 3_600 };
    expect(operation.id).toBe(rescheduled.id);
    expect(operation.key).not.toBe(rescheduled.key);

    const keys = listItemKeys([operation, rescheduled]);

    expect(keys).toHaveLength(2);
    // THE LOAD-BEARING ONE: same id on both operations, so this is only satisfiable from `key`.
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([operation.key, rescheduled.key]);

    // And the row's own criterion: both are actually rendered.
    const html = renderOperations([operation, rescheduled]);
    expect(html).toContain("Update fee policy");
    expect(html).toContain("Rotate guardian");
  });

  it("falls back to the target and selector when the label is blank", () => {
    const html = renderOperations([{ ...operation, label: "   " }]);

    expect(html).toContain("Admin operation scheduled");
    expect(html).toContain(`${operation.target} ${operation.selector}`);
  });

  it("ignores operations without a safe positive ready time", () => {
    expect(renderOperations([
      { ...operation, readyAt: 0 },
      { ...operation, key: `0x${"3".repeat(64)}:1`, id: `0x${"3".repeat(64)}`,
        readyAt: Number.MAX_SAFE_INTEGER },
    ])).toBe("");
  });

  it("stays hidden until config reports a pending operation", () => {
    expect(renderOperations(undefined)).toBe("");
    expect(renderOperations([])).toBe("");
  });
});
