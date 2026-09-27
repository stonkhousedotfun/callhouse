import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ConfigResponse } from "./api-types";
import {
  ADMIN_SAFE_ROLE_IDS, adminSafeActsImmediately, adminSafeHolderDelay, formatDelay, NEW_LISTING_NOTE, NEW_LISTING_ROLE_ID,
  ROLE_ID, roleScopeNote,
} from "./adminDelays";

const SAFE = "0x00000000000000000000000000000000000000aB";
const OTHER = "0x00000000000000000000000000000000000000cd";
type Source = Pick<ConfigResponse, "access" | "safes">;

/** Every admin lane held by the Safe at `delays[id]` (default 0), plus an unrelated holder at a different delay. */
function config(delays: Partial<Record<number, number>> = {}, name = (id: number) => `ROLE_${id}`): Source {
  return {
    safes: { admin: SAFE, treasury: null },
    access: {
      manager: "0x0000000000000000000000000000000000000003",
      roles: ADMIN_SAFE_ROLE_IDS.map((id) => ({
        id, name: name(id), delayS: 999,
        holders: [{ address: OTHER, delayS: 777 }, { address: SAFE.toLowerCase(), delayS: delays[id] ?? 0 }],
      })),
    },
  };
}

describe("adminSafeHolderDelay", () => {
  it("reads the Safe's HOLDER delay on the role, not the role's grant delay and not another holder's", () => {
    expect(adminSafeHolderDelay(config({ [ROLE_ID.FEE_MANAGER]: 172_800 }), ROLE_ID.FEE_MANAGER)).toBe(172_800);
    expect(adminSafeHolderDelay(config(), ROLE_ID.FEE_MANAGER)).toBe(0);
  });

  it("matches the role by numeric id, whatever its name ('FEE_MANAGER' or 'FEE_MANAGER_ROLE')", () => {
    const bare = config({ 1: 60 }, (id) => ["ADMIN", "FEE_MANAGER"][id] ?? "X");
    const suffixed = config({ 1: 60 }, (id) => ["ADMIN_ROLE", "FEE_MANAGER_ROLE"][id] ?? "X");
    expect(adminSafeHolderDelay(bare, 1)).toBe(60);
    expect(adminSafeHolderDelay(suffixed, 1)).toBe(60);
  });

  it("compares the Safe address case-insensitively", () => {
    const upper = { ...config({ 1: 5 }), safes: { admin: SAFE.toUpperCase().replace("0X", "0x"), treasury: null } };
    expect(adminSafeHolderDelay(upper, 1)).toBe(5);
  });

  it("is null (unread) for no config, no access table, a missing role, no Safe address, or the Safe not holding the role", () => {
    const base = config();
    expect(adminSafeHolderDelay(undefined, 1)).toBeNull();
    expect(adminSafeHolderDelay({ ...base, access: undefined }, 1)).toBeNull();
    expect(adminSafeHolderDelay({ ...base, access: { ...base.access!, roles: base.access!.roles.filter((r) => r.id !== 1) } }, 1)).toBeNull();
    expect(adminSafeHolderDelay({ ...base, safes: undefined }, 1)).toBeNull();
    expect(adminSafeHolderDelay({ ...base, safes: { admin: null, treasury: null } }, 1)).toBeNull();
    expect(adminSafeHolderDelay({ ...base, safes: { admin: "0x00000000000000000000000000000000000000ee", treasury: null } }, 1)).toBeNull();
  });
});

describe("adminSafeActsImmediately", () => {
  it("true only when the Safe's holder delay is 0 on every one of role ids 0-5", () => {
    expect(ADMIN_SAFE_ROLE_IDS).toEqual([0, 1, 2, 3, 4, 5]);
    expect(adminSafeActsImmediately(config())).toBe(true);
  });

  it("false when any lane is non-zero, unread or missing", () => {
    for (const id of ADMIN_SAFE_ROLE_IDS) expect(adminSafeActsImmediately(config({ [id]: 86_400 })), `role ${id}`).toBe(false);
    const base = config();
    for (const id of ADMIN_SAFE_ROLE_IDS) {
      const missing = { ...base, access: { ...base.access!, roles: base.access!.roles.filter((r) => r.id !== id) } };
      expect(adminSafeActsImmediately(missing), `role ${id} missing`).toBe(false);
    }
    expect(adminSafeActsImmediately(undefined)).toBe(false);
    expect(adminSafeActsImmediately({ ...base, safes: undefined })).toBe(false);
  });
});

// The id is typed here like every ROLE_ID, so it is pinned against the published
// manifest the chain is configured from (ops/abis/v2/roles.json), read, not re-typed.
const MANIFEST = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../ops/abis/v2/roles.json"), "utf8")) as {
  roles: Record<string, number>; delaysS: Record<string, number>; targets: Record<string, Record<string, string>>;
};

describe("NEW_LISTING, the zero-delay first-listing lane", () => {
  it("is the manifest's NEW_LISTING id, with no delay, and every ROLE_ID lane is the manifest's too", () => {
    expect(NEW_LISTING_ROLE_ID).toBe(MANIFEST.roles.NEW_LISTING);
    expect(MANIFEST.delaysS.NEW_LISTING).toBe(0);
    for (const [name, id] of Object.entries(ROLE_ID)) expect(MANIFEST.roles[name], name).toBe(id);
    expect(MANIFEST.targets.Clearinghouse?.["registerMarket(address,uint64,bool)"]).toBe("NEW_LISTING");
  });

  it("is not one of the six guardian-cancellable lanes, and adminSafeActsImmediately never reads it", () => {
    expect(ADMIN_SAFE_ROLE_IDS).not.toContain(NEW_LISTING_ROLE_ID);
    const withNewListing = (source: Source, delayS: number): Source => ({
      ...source,
      access: { ...source.access!, roles: [...source.access!.roles, {
        id: NEW_LISTING_ROLE_ID, name: "NEW_LISTING", delayS: 0, holders: [{ address: SAFE, delayS }],
      }] },
    });
    // After the lock: the six lanes are delayed and NEW_LISTING stays at 0. That 0 must not read as "immediate".
    const locked = Object.fromEntries(ADMIN_SAFE_ROLE_IDS.map((id) => [id, 3_600]));
    expect(adminSafeActsImmediately(withNewListing(config(locked), 0))).toBe(false);
    // Before the lock every lane is 0, with or without NEW_LISTING indexed yet.
    expect(adminSafeActsImmediately(withNewListing(config(), 0))).toBe(true);
    expect(adminSafeActsImmediately(config())).toBe(true);
  });

  it("carries the scope note the Trust page shows, and no other role does", () => {
    expect(roleScopeNote(NEW_LISTING_ROLE_ID)).toBe(NEW_LISTING_NOTE);
    expect(NEW_LISTING_NOTE).toMatch(/^No delay by design/);
    expect(NEW_LISTING_NOTE).toMatch(/only set up a market that does not exist yet/);
    expect(NEW_LISTING_NOTE).toMatch(/existing market still waits on its delayed role/);
    for (const id of [...ADMIN_SAFE_ROLE_IDS, 6, 7, 8, 9, 10]) expect(roleScopeNote(id), `role ${id}`).toBeNull();
  });
});

describe("formatDelay", () => {
  it("renders 0 as 'No delay', never '0 seconds'", () => {
    expect(formatDelay(0)).toBe("No delay");
  });

  it("whole days, whole hours, else seconds", () => {
    expect(formatDelay(172_800)).toBe("2 days");
    expect(formatDelay(86_400)).toBe("1 day");
    expect(formatDelay(3_600)).toBe("1 hour");
    expect(formatDelay(1_800)).toBe("1800 seconds");
  });
});
