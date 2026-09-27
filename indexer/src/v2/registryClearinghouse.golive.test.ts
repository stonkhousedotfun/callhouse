import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import { REGISTRY_CLEARINGHOUSE_MISMATCH, assertRegistryClearinghouse } from "./registryClearinghouse";

/**
 * On go-live day the indexer's V2_CLEARINGHOUSE and its baked registry must change in
 * the same step, or the V2_PRODUCTION=1 process refuses to start. They do, because both are derived from ONE registry
 * file by the launch-day regen (ops/v2/post-broadcast-regen.mjs):
 *
 *   ops/v2-env.mjs                        -> ops/v2/env/indexer-v2.env   V2_CLEARINGHOUSE, V2_PRODUCTION=1
 *   indexer/scripts/gen-v2-registry.mjs   -> indexer/lib/v2/marketRegistry.generated.ts   contracts.clearinghouse
 *
 * and go-live-v2.sh --apply --ref <sha> sets the env from that ref's rendered file (--skip-deploys) and builds the image
 * from that ref's clone (`railway up`). This runs both generators on a v9-shaped registry (a Clearinghouse the committed
 * image does not carry) and feeds the pair to the boot check, the way ponder.config.ts does.
 */
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const V9_CLEARINGHOUSE = "0x000000000000000000000000000000000000c739";

const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Baked = Parameters<typeof assertRegistryClearinghouse>[0]["registry"];

/** The launch-day pair for one registry file: the rendered indexer env and the generated baked registry. */
function launchDayPair(registry: object) {
  const dir = mkdtempSync(path.join(tmpdir(), "t-op-739-golive-"));
  scratches.push(dir);
  const file = path.join(dir, "tier1.json");
  writeFileSync(file, JSON.stringify(registry));
  const render = spawnSync(process.execPath, [
    path.join(repo, "ops/v2-env.mjs"), "--registry", file, "--out", dir, "--services", "indexer-v2",
  ], { encoding: "utf8" });
  expect(render.status, render.stderr).toBe(0);
  const env: Record<string, string> = {};
  for (const line of readFileSync(path.join(dir, "indexer-v2.env"), "utf8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!;
  }
  const output = path.join(dir, "marketRegistry.generated.ts");
  const gen = spawnSync(process.execPath, [
    path.join(repo, "indexer/scripts/gen-v2-registry.mjs"), "--registry", file, "--output", output,
  ], { encoding: "utf8" });
  expect(gen.status, gen.stderr).toBe(0);
  // Parsed the way scripts/gen-v2-registry.test.ts reads the generator's output.
  const baked = JSON.parse(readFileSync(output, "utf8").split("export const V2_REGISTRY = ")[1]!.split(" as const;")[0]!);
  return { env, baked: baked as Baked };
}

function v9Registry() {
  const registry = JSON.parse(readFileSync(path.join(repo, "ops/markets/tier1.json"), "utf8"));
  expect(Object.hasOwn(registry, "_dev"), "tier1.json is the production registry").toBe(false);
  registry.v2.contracts.clearinghouse = V9_CLEARINGHOUSE;
  return registry;
}

function boot(env: Record<string, string>, registry: Baked): string | null {
  try {
    assertRegistryClearinghouse({
      production: env.V2_PRODUCTION === "1", clearinghouse: env.V2_CLEARINGHOUSE, registry, warn: () => {},
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("go-live: the indexer's V2_CLEARINGHOUSE and its baked registry come from one registry", () => {
  it("renders V2_CLEARINGHOUSE and V2_PRODUCTION=1 from the registry, and bakes the same Clearinghouse", () => {
    const { env, baked } = launchDayPair(v9Registry());
    expect(env.V2_PRODUCTION).toBe("1");
    expect(env.V2_CLEARINGHOUSE?.toLowerCase()).toBe(V9_CLEARINGHOUSE);
    expect(baked.contracts.clearinghouse?.toLowerCase()).toBe(V9_CLEARINGHOUSE);
  });

  it("boots with the regenerated pair", () => {
    const { env, baked } = launchDayPair(v9Registry());
    expect(boot(env, baked)).toBeNull();
  });

  it("refuses by name when the image predates the regen (the v9 env on the committed baked registry)", () => {
    // Positive control for the case above: the committed image does not carry the v9 Clearinghouse, so the same env
    // must refuse, and the refusal is 695's own line.
    expect(V2_REGISTRY.contracts.clearinghouse.toLowerCase()).not.toBe(V9_CLEARINGHOUSE);
    const { env } = launchDayPair(v9Registry());
    const refusal = boot(env, V2_REGISTRY as unknown as Baked);
    expect(refusal).toContain(`${REGISTRY_CLEARINGHOUSE_MISMATCH}: V2_CLEARINGHOUSE ${env.V2_CLEARINGHOUSE} is not the baked`);
    expect(refusal).toContain("Refusing to start");
  });

  it("refuses by name when the env was rendered from another registry than the image was built from", () => {
    const committed = JSON.parse(readFileSync(path.join(repo, "ops/markets/tier1.json"), "utf8"));
    const { baked } = launchDayPair(v9Registry());
    const { env } = launchDayPair(committed);
    expect(boot(env, baked)).toContain(REGISTRY_CLEARINGHOUSE_MISMATCH);
  });
});
