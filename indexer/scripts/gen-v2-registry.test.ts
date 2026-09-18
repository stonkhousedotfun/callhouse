import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const base = () => ({ v2: { interfaceVersion: 7, deployBlock: 123, contracts: {},
  fees: { premiumFeeBps: 0, mintFeePpm: 80 }, defaults: { ladder: {} } },
  markets: [{ ticker: "NVDA", name: "NVIDIA", asset: "0x1111111111111111111111111111111111111111",
    v2: { status: "live", strikeTick: 1_000_000, puts: true, mintFeePpm: undefined as number | undefined,
      overrides: undefined as { mintFeePpm?: number } | undefined } }] });
function run(registry: ReturnType<typeof base>) {
  const dir = mkdtempSync(join(tmpdir(), "stonkhouse-v7-registry-test-")); paths.push(dir);
  const source = join(dir, "registry.json"), output = join(dir, "output.ts");
  writeFileSync(source, JSON.stringify(registry));
  const result = spawnSync(process.execPath, [new URL("./gen-v2-registry.mjs", import.meta.url).pathname,
    "--registry", source, "--output", output], { encoding: "utf8" });
  const data = result.status === 0 ? JSON.parse(readFileSync(output, "utf8").split("export const V2_REGISTRY = ")[1]!.split(" as const;")[0]!) : null;
  return { ...result, data };
}

describe("v7 consumer registry projection", () => {
  it("retains shared rent defaults and explicit market overrides", () => {
    const registry = base();
    expect(run(registry).data).toMatchObject({ interfaceVersion: 7, fees: { mintFeePpm: 80 }, markets: [{ mintFeePpm: 80 }] });
    registry.markets[0]!.v2.mintFeePpm = 300;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(300);
    // Zero is a valid contract/local-test rate; deployment/refusal gates own live approval.
    registry.markets[0]!.v2.mintFeePpm = 0;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(0);
  });
  it("rejects an older interface before rendering v7-only code", () => {
    const registry = base(); registry.v2.interfaceVersion = 6;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("requires interfaceVersion 7") });
  });
  it("matches deploy precedence: direct market rate, legacy override, shared default", () => {
    const registry = base();
    registry.markets[0]!.v2.overrides = { mintFeePpm: 150 };
    expect(run(registry).data.markets[0].mintFeePpm).toBe(150);
    registry.markets[0]!.v2.mintFeePpm = 300;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(300);
    registry.markets[0]!.v2.mintFeePpm = undefined;
    registry.markets[0]!.v2.overrides.mintFeePpm = 0;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(0);
  });
  it.each([undefined, -1, 5_001, 0.5])("rejects missing or invalid shared rent %s", (ppm) => {
    const registry = base(); registry.v2.fees.mintFeePpm = ppm as number;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("v2.fees.mintFeePpm must be ppm") });
  });
  it.each([-1, 5_001, 0.5])("rejects an invalid override %s", (ppm) => {
    const registry = base(); registry.markets[0]!.v2.mintFeePpm = ppm;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("NVDA.v2.mintFeePpm must be ppm") });
  });
  it.each([-1, 5_001, 0.5])("rejects an invalid legacy override %s", (ppm) => {
    const registry = base(); registry.markets[0]!.v2.overrides = { mintFeePpm: ppm };
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("NVDA.v2.mintFeePpm must be ppm") });
  });
});
