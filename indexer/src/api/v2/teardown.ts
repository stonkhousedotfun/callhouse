/**
 * Test-only teardown for the seeded PGlite scenario in routes.test.ts. Nothing in the API imports it.
 *
 * WHY IT EXISTS. A test seeds a row through drizzle, and ponder's hex column lowercases the address on
 * the way in (`PgHex.mapToDriverValue`). A raw `DELETE ... WHERE vault = $1` given the CHECKSUMMED value
 * from getAddress() matches nothing, and `pg.query` reports that as success. The seed then outlives its
 * test and every later test that lists the entity sees a row it never created: the later test fails, and
 * passes in isolation. T-452 found fifteen of these by probe (`rows deleted: 0`).
 *
 * THE RULE. Every step names how many rows its test seeded, and the teardown FAILS unless it removed
 * exactly that many. Fewer is the silent miss above. More means the predicate reached rows this test did
 * not seed - a shared seed another test depends on, or a table-wide delete hiding a mismatch. A warning
 * would be exit 0, which is how the miss survived a whole day, so this throws.
 *
 * Every step runs before anything throws, so one miss does not leave the remaining seeds behind, and the
 * error names each table, predicate and key that fell short.
 */

type Queryable = { query(statement: string, params?: unknown[]): Promise<{ affectedRows?: number }> };

/** `[statement, params, seeded]`; `seeded` defaults to 1. */
export type TeardownStep = readonly [statement: string, params?: readonly unknown[], seeded?: number];

function key(params: readonly unknown[]): string {
  return JSON.stringify(params, (_, value) => (typeof value === "bigint" ? `${value}n` : value));
}

export async function teardown(client: Queryable, steps: readonly TeardownStep[]): Promise<void> {
  const misses: string[] = [];
  for (const [statement, params = [], seeded = 1] of steps) {
    const { affectedRows = 0 } = await client.query(statement, [...params]);
    if (affectedRows !== seeded) {
      const table = /DELETE\s+FROM\s+"?(\w+)"?/i.exec(statement)?.[1] ?? statement;
      misses.push(`${table}: removed ${affectedRows} of ${seeded} seeded row(s) - ${statement} ${key(params)}`);
    }
  }
  if (misses.length > 0) {
    throw new Error(`teardown did not remove what its test seeded:\n  ${misses.join("\n  ")}`);
  }
}
