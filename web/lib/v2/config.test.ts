import { describe, expect, it } from "vitest";
import configFixture from "../../../ops/fixtures/api/v2/config.json";

import { configResponseSchema } from "./api-schema";
import { V2_DEPLOYMENT, requireV2Address, v2ConfigWarnings } from "./config";

describe("v2 deployment guard", () => {
  it("uses only compiled registry addresses for writes", () => {
    if (V2_DEPLOYMENT.contracts.orderBook) {
      expect(requireV2Address("orderBook")).toBe(V2_DEPLOYMENT.contracts.orderBook);
    } else {
      expect(() => requireV2Address("orderBook")).toThrow(/not deployed/);
    }
  });

  it("includes the access manager in the compiled deployment guard", () => {
    const config = configResponseSchema.parse(configFixture);
    const aligned = {
      ...config,
      contracts: { ...config.contracts, accessManager: V2_DEPLOYMENT.contracts.accessManager },
    };
    expect(v2ConfigWarnings(aligned)).not.toContain("accessManager address differs from the generated registry.");

    const mismatched = V2_DEPLOYMENT.contracts.accessManager === null
      ? config.contracts.clearinghouse
      : null;
    expect(v2ConfigWarnings({
      ...aligned,
      contracts: { ...aligned.contracts, accessManager: mismatched },
    })).toContain("accessManager address differs from the generated registry.");
  });

  it("flags fixture addresses that disagree with the compiled registry", () => {
    const config = configResponseSchema.parse(configFixture);
    expect(v2ConfigWarnings({ ...config, chainId: config.chainId + 1 })).toContain("Indexer chain differs from this app.");
    expect(v2ConfigWarnings({ ...config, constants: { ...config.constants, priceTick: 999 } }))
      .toContain("priceTick constant differs from the app's option maths.");
  });

  it("requires the v8 interface on both the indexer and compiled registry", () => {
    const config = configResponseSchema.parse(configFixture);
    expect(v2ConfigWarnings({ ...config, interfaceVersion: 8 }))
      .not.toContain("This build requires interface version 8.");
    expect(v2ConfigWarnings({ ...config, interfaceVersion: 7 }))
      .toContain("This build requires interface version 8.");
  });

  it("allows live fees to change without disabling writes", () => {
    const config = configResponseSchema.parse(configFixture);
    const changed = { ...config, fees: {
      ...config.fees,
      premiumFeeBps: config.fees.premiumFeeBps + 1,
      takerFeeFlat: { ...config.fees.takerFeeFlat, raw: String(BigInt(config.fees.takerFeeFlat.raw) + 1n) },
    } };
    expect(v2ConfigWarnings(changed)).toEqual(v2ConfigWarnings(config));
  });

  it("requires the explicit pending fee field and rejects unknown schedule fields", () => {
    const config = configResponseSchema.parse(configFixture);
    expect(config.pendingFees).toBeNull();
    const { pendingFees: _pending, ...missing } = config;
    expect(configResponseSchema.safeParse(missing).success).toBe(false);
    expect(configResponseSchema.safeParse({ ...config, pendingFees: { ...config.fees,
      effectiveAt: 1_800_000_000, unknown: true } }).success).toBe(false);
  });

  it("rejects a config that points wallet approval at a different USDG token", () => {
    const config = configResponseSchema.parse(configFixture);
    const wrong = { ...config, usdg: { ...config.usdg, address: config.contracts.clearinghouse! } };
    expect(v2ConfigWarnings(wrong)).toContain("USDG address differs from this app.");
  });
});
