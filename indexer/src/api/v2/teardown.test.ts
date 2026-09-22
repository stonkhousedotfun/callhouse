import { PGlite } from "@electric-sql/pglite";
import { getAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { teardown } from "./teardown";

// The shape T-452 found: the row is stored lowercase, the teardown is handed the checksummed form.
const STORED = `0x${"a1".repeat(20)}`;
const CHECKSUMMED = getAddress(STORED);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("CREATE TABLE seeded (id text PRIMARY KEY, vault text)");
});

afterAll(async () => { await pg?.close(); });

beforeEach(async () => {
  await pg.exec("DELETE FROM seeded");
  await pg.query("INSERT INTO seeded VALUES ('a', $1), ('b', $1), ('shared', '0xshared')", [STORED]);
});

describe("teardown", () => {
  it("passes when each step removes exactly what its test seeded", async () => {
    await teardown(pg, [
      ["DELETE FROM seeded WHERE lower(vault) = lower($1)", [CHECKSUMMED], 2],
      ["DELETE FROM seeded WHERE id = 'shared'"],
    ]);
    expect((await pg.query("SELECT id FROM seeded")).rows).toEqual([]);
  });

  it("fails, naming the table and key, when a checksummed delete matches the lowercase row", async () => {
    await expect(teardown(pg, [["DELETE FROM seeded WHERE vault = $1", [CHECKSUMMED], 2]]))
      .rejects.toThrow(`seeded: removed 0 of 2 seeded row(s) - DELETE FROM seeded WHERE vault = $1 ["${CHECKSUMMED}"]`);
  });

  it("fails when the predicate reaches rows the test did not seed", async () => {
    await expect(teardown(pg, [["DELETE FROM seeded WHERE id IN ('a', 'shared')"]]))
      .rejects.toThrow("seeded: removed 2 of 1 seeded row(s)");
  });

  it("runs every step before it throws, so one miss does not strand the rest", async () => {
    await expect(teardown(pg, [
      ["DELETE FROM seeded WHERE vault = $1", [CHECKSUMMED], 2],
      ["DELETE FROM seeded WHERE id = 'shared'"],
    ])).rejects.toThrow(/removed 0 of 2/);
    expect((await pg.query("SELECT id FROM seeded ORDER BY id")).rows).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
