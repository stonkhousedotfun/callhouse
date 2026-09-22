/**
 * The two desync guards in src/v2/accessManager.ts, one per direction.
 *
 * T-501: only the addressByName -> manifest direction existed, so a manifest target with NO entry
 * here passed in silence — `targetAddresses` maps it to null through `?? null`, and a null is
 * indistinguishable from a deliberate "no address source exists". EarnVault sat unlabelled for a
 * whole interface version behind an assertion that reads as if it covered exactly that case, and
 * StockVenueAdapter was sitting behind it too.
 *
 * Both guards run at MODULE SCOPE, so every case here imports the module for its side effect and
 * asserts on whether the import resolves or rejects. `ponder:schema` and `../../lib/registry` are
 * virtual modules that only exist inside a Ponder process, mocked the same way
 * houseVault.handler.test.ts:34-41 does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The minimum lib/env.ts needs to load: an archive RPC, and ONE deployment shape — it refuses to
// boot with none set, and refuses V2_START_BLOCK without V2_CLEARINGHOUSE. Nothing beyond that is
// stubbed, and the placeholder address is deliberately not a real one: the guards under test read
// the role manifest and the KEYS of addressByName, never the resolved addresses, so no stubbed
// address can paper over what they check. The same preamble shape as houseVault.handler.test.ts:21-29.
vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
});

vi.mock("../../lib/registry", () => ({
  v2AccessManagerPonder: { on: () => {} },
}));

vi.mock("ponder:schema", () => ({
  default: {
    v2AccessRole: "v2AccessRole",
    v2AccessTargetFunction: "v2AccessTargetFunction",
    v2AccessOperation: "v2AccessOperation",
  },
}));

const MODULE = "./accessManager";
const MANIFEST = "../../lib/v2/accessManagerRoles.generated";

/** The real manifest, so the fixtures below mutate a true shape rather than a guess. */
const { V2_ACCESS_MANIFEST: REAL } = await import(MANIFEST);

const withTargets = (targets: Record<string, unknown>) => {
  vi.doMock(MANIFEST, () => ({ V2_ACCESS_MANIFEST: { ...REAL, targets } }));
};

describe("accessManager address/manifest desync guards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock(MANIFEST);
  });

  it("imports cleanly as shipped: every manifest target is listed, and no listed name is unknown", async () => {
    // The positive control. Without it the two cases below prove nothing — a module that threw for
    // an unrelated reason would satisfy both `rejects` assertions while the guards did nothing.
    await expect(import(MODULE)).resolves.toBeDefined();
  });

  it("throws when the manifest carries a target this file does not list — the T-501 direction", async () => {
    withTargets({ ...REAL.targets, NewlyAddedVault: {} });
    await expect(import(MODULE)).rejects.toThrow(/no entry for role-manifest targets: NewlyAddedVault/);
  });

  it("still throws in the original direction when the manifest drops a name this file lists", async () => {
    const { Clearinghouse: _dropped, ...rest } = REAL.targets as Record<string, unknown>;
    withTargets(rest);
    await expect(import(MODULE)).rejects.toThrow(/absent from the role manifest: Clearinghouse/);
  });
});
