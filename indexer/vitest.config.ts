/**
 * Vitest for the indexer. Node environment, tests live under src/.
 *
 * The event handlers in src/*.ts import `ponder:registry` and `ponder:schema`, which are virtual
 * modules that only exist inside a Ponder process. Vitest cannot resolve them, and no alias is
 * provided here on purpose: a test that mocked the registry would be testing the mock. What is
 * unit-testable is the pure code the handlers call — lib/indexing.ts (cycle and epoch maths,
 * the "unfilled, 0" row), lib/env.ts, lib/roles.ts — and the API's own helpers in src/api/
 * (serialize.ts, hmac.ts, cache.ts), none of which need a database or an RPC.
 *
 * `passWithNoTests` is deliberately NOT set. An empty run must fail. A test step that goes green
 * with zero tests is not a gate, and CI runs `pnpm --filter @callhouse/indexer test` as a gate.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
