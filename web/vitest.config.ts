/**
 * Vitest for the dapp. Node environment only. What is unit-testable here is the arithmetic and
 * the normalisation: lib/format.ts (a USDG figure is 6 decimals, the asset and shares are 18,
 * and formatting one with the other is the bug this catches) and the tolerant response shaping
 * in lib/api.ts. lib/hooks.ts and lib/history.ts are React and wagmi bound and are not in scope
 * for a node run; a jsdom environment is deliberately absent, because it would make it easy to
 * test rendered copy instead of the numbers behind it, and the copy already has its own gate in
 * scripts/copy-lint.mjs (which also scans this file and every test under web/).
 *
 * The one piece of configuration that matters is the alias: tsconfig maps `@/*` to the package
 * root, and a module that imports `@/lib/contracts` has to resolve the same way under vitest as
 * it does under Next, or the test would exercise a different file from the one that ships.
 *
 * `passWithNoTests` is deliberately NOT set. An empty run must fail. A test step that goes green
 * with zero tests is not a gate, and CI runs `pnpm --filter @callhouse/web test` as a gate.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
  },
});
