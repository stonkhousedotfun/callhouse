/**
 * Leaf-by-leaf comparison of API responses against expected values. Pure: no network, no Ponder.
 *
 * An expectation names one route, one path into that route's JSON body, and the exact value the
 * leaf must hold. Comparison is strict (`===` on JSON scalars, recursive on arrays and objects):
 * `"0"` is not `0`, `null` is not a missing key, and a checksummed address is not its lowercase
 * form. A path that does not resolve reports `<missing>`, never `undefined === undefined`.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type Expectation = {
  /** e.g. `GET /v1/cycles/3`. Must match a key of the responses map. */
  route: string;
  /** Dotted path with `[i]` indices, e.g. `cycle.harvest.premiumNet.raw`. Empty = the whole body. */
  path: string;
  expected: Json;
  /** Where the expected value came from, for the failure report (e.g. `run.json cycle3.queue.escrowUsdg`). */
  source?: string;
};

export type Mismatch = Expectation & { actual: Json | typeof MISSING };

export const MISSING: unique symbol = Symbol("missing");

type Segment = string | number;

export function parsePath(path: string): Segment[] {
  if (path === "") return [];
  const out: Segment[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

export function getPath(body: Json | undefined, path: string): Json | typeof MISSING {
  let cur: Json | undefined = body;
  for (const seg of parsePath(path)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return MISSING;
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) return MISSING;
      cur = cur[seg];
    } else if (Array.isArray(cur) && seg === "length") {
      // `rows.length` pins how many elements a route returned, so an extra row is a mismatch too.
      cur = cur.length;
    } else {
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return MISSING;
      cur = (cur as { [k: string]: Json })[seg];
    }
  }
  return cur === undefined ? MISSING : cur;
}

export function jsonEqual(a: Json | typeof MISSING, b: Json | typeof MISSING): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i] as Json));
  }
  const ao = a as { [k: string]: Json };
  const bo = b as { [k: string]: Json };
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && jsonEqual(ao[k] as Json, bo[k] as Json));
}

export function compare(
  responses: Record<string, Json>,
  expectations: readonly Expectation[],
): { passed: number; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  let passed = 0;
  for (const e of expectations) {
    const body = responses[e.route];
    const actual = body === undefined ? MISSING : getPath(body, e.path);
    if (jsonEqual(actual, e.expected)) passed += 1;
    else mismatches.push({ ...e, actual });
  }
  return { passed, mismatches };
}

const show = (v: Json | typeof MISSING): string => (v === MISSING ? "<missing>" : JSON.stringify(v));

export function formatMismatches(mismatches: readonly Mismatch[]): string {
  const lines: string[] = [];
  let lastRoute = "";
  for (const m of mismatches) {
    if (m.route !== lastRoute) {
      lines.push(`  ${m.route}`);
      lastRoute = m.route;
    }
    lines.push(`    ${m.path === "" ? "<body>" : m.path}`);
    lines.push(`      expected ${show(m.expected)}${m.source ? `   (${m.source})` : ""}`);
    lines.push(`      actual   ${show(m.actual)}`);
  }
  return lines.join("\n");
}
