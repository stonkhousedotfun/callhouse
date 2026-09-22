import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeIntake,
  knownDevKeyEntries,
  offlineIssues,
  verifyOnChain,
  writeBackPaths,
  writeBackRecord,
} from "./safes-verify.mjs";

const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const intake = normalizeIntake({
  adminSafe: addr(101),
  treasurySafe: addr(102),
  guardian: addr(103),
  opsWallet: addr(104),
  owners: [addr(201), addr(202), addr(203)],
});

const roles = {
  roles: { GUARDIAN: 7 },
  holders: { adminSafe: ["ADMIN", "GUARDIAN"], guardianKey: ["GUARDIAN"] },
};
const registry = {
  shared: {
    chainId: 4663,
    admin: null,
    guardian: null,
    opsWallet: null,
    safes: { admin: null, treasury: null },
    oldContract: addr(301),
  },
  v2: { bots: { guardian: null } },
  markets: [{ ticker: "OLD", deployment: { keeper: addr(302) }, v2: { future: addr(303) } }],
};
const devRegistry = { shared: { admin: addr(401), guardian: addr(402) } };
const v7Legacy = { shared: { oldOpsWallet: addr(601) } };
const knownTestKeys = knownDevKeyEntries({
  devnetSource: 'const ANVIL_MNEMONIC = "public test mnemonic";',
  upSource: "anvil --accounts 2",
  derive: (_mnemonic, index) => addr(501 + index),
});

function fakeClient({ chainId = 4663, noCode = [], threshold = {}, owners = {} } = {}) {
  return {
    getChainId: async () => chainId,
    getCode: async ({ address }) => noCode.map((x) => x.toLowerCase()).includes(address.toLowerCase()) ? "0x" : "0x6000",
    readContract: async ({ address, functionName }) => {
      const key = address.toLowerCase();
      if (functionName === "getThreshold") return threshold[key] ?? 2n;
      if (functionName === "getOwners") return owners[key] ?? intake.owners;
      throw new Error(`unexpected ${functionName}`);
    },
  };
}

test("prove-by-breaking control: restored offline identities and guardian holder are green", () => {
  assert.deepEqual(offlineIssues({ intake, registry, devRegistry, roles }), []);
});

test("prove-by-breaking: a pairwise collision fails by the duplicated input name", () => {
  const duplicate = { ...intake, opsWallet: intake.guardian };
  assert.match(offlineIssues({ intake: duplicate, registry, devRegistry, roles }).join("\n"), /ops wallet: duplicates guardian/);
});

test("prove-by-breaking: v7 and dev/test reuse fail by input name and source path", () => {
  const reused = { ...intake, adminSafe: addr(302), treasurySafe: addr(601), guardian: addr(401), opsWallet: addr(501) };
  const issues = offlineIssues({ intake: reused, registry, v7Legacy, devRegistry, roles, knownTestKeys }).join("\n");
  assert.match(issues, /Admin Safe:.*v7 registry:markets\[0\]\.deployment\.keeper/);
  assert.match(issues, /Treasury Safe:.*v7 legacy registry:shared\.oldOpsWallet/);
  assert.match(issues, /guardian:.*dev\/test registry:shared\.admin/);
  assert.match(issues, /ops wallet:.*known Anvil test key:ops\/devnet account #0/);
});

test("prove-by-breaking: deleting guardianKey from the manifest is red", () => {
  const brokenRoles = { ...roles, holders: { adminSafe: roles.holders.adminSafe } };
  assert.match(offlineIssues({ intake, registry, devRegistry, roles: brokenRoles }).join("\n"), /holders\.guardianKey is absent/);
});

test("prove-by-breaking: an EOA fails by Safe name", async () => {
  const result = await verifyOnChain({
    client: fakeClient({ noCode: [intake.adminSafe] }),
    intake,
    expectedChainId: 4663,
  });
  assert.match(result.issues.join("\n"), /Admin Safe: .* has no bytecode; it is an EOA/);
});

test("prove-by-breaking: a wrong threshold fails by Safe name", async () => {
  const result = await verifyOnChain({
    client: fakeClient({ threshold: { [intake.treasurySafe.toLowerCase()]: 1n } }),
    intake,
    expectedChainId: 4663,
  });
  assert.match(result.issues.join("\n"), /Treasury Safe: threshold is 1, expected 2/);
});

test("prove-by-breaking: deleting one expected owner fails by Safe name", async () => {
  const result = await verifyOnChain({
    client: fakeClient({ owners: { [intake.adminSafe.toLowerCase()]: intake.owners.slice(0, 2) } }),
    intake,
    expectedChainId: 4663,
  });
  const errors = result.issues.join("\n");
  assert.match(errors, /Admin Safe: owner count is 2, expected 3/);
  assert.match(errors, new RegExp(`Admin Safe: missing expected owner\\(s\\) ${intake.owners[2]}`, "i"));
});

test("prove-by-breaking control: restored bytecode, threshold and owners are green", async () => {
  const result = await verifyOnChain({ client: fakeClient(), intake, expectedChainId: 4663 });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.safes.map((safe) => [safe.threshold, safe.owners.length]), [[2n, 3], [2n, 3]]);
});

test("prove-by-breaking: wrong RPC chain stops before either Safe is read", async () => {
  let reads = 0;
  const client = fakeClient({ chainId: 1 });
  client.getCode = async () => { reads += 1; return "0x6000"; };
  const result = await verifyOnChain({ client, intake, expectedChainId: 4663 });
  assert.match(result.issues.join("\n"), /connected to 1, expected 4663/);
  assert.equal(reads, 0);
});

test("verified record exposes only the existing generator's six intake paths", () => {
  assert.deepEqual(writeBackRecord(intake), {
    safes: { admin: intake.adminSafe, treasury: intake.treasurySafe },
    wallets: { guardian: intake.guardian, opsWallet: intake.opsWallet },
    bots: { guardian: intake.guardian },
  });
  assert.deepEqual(writeBackPaths(intake), [
    "shared.safes.admin",
    "shared.safes.treasury",
    "shared.admin",
    "shared.guardian",
    "shared.opsWallet",
    "v2.bots.guardian",
  ]);
});
