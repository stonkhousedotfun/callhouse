// node --test ops/v2/rehearse/keeper-defaults.test.mjs
//
// Every keeper default keeper-defaults.mjs mirrors, read back from the keeper source it names. A default the
// keeper changes without this mirror following would move the rehearsal's dual-market open, its feed heartbeat or the
// reprice drill's expected price out from under them, silently.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as mirror from "./keeper-defaults.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const num = (text) => BigInt(text.replaceAll("_", ""));

/**
 * The `.default(N)` of one zod field in keeper/src/v2/config.ts. The default may be a named constant exported from the same
 * file (MM_OPEN_GRACE_S defaults to MM_OPEN_GRACE_DEFAULT_S); that constant's literal is read.
 */
function configDefault(name) {
  const text = source("keeper/src/v2/config.ts");
  const m = new RegExp(`^\\s*${name}: intField\\([^)]*\\)\\.default\\(([0-9_]+|[A-Z][A-Z0-9_]*)\\),`, "m").exec(text);
  assert.ok(m, `keeper/src/v2/config.ts has no intField default for ${name}`);
  if (/^[0-9_]+$/.test(m[1])) return num(m[1]);
  const named = new RegExp(`^export const ${m[1]} = ([0-9_]+);`, "m").exec(text);
  assert.ok(named, `keeper/src/v2/config.ts defaults ${name} to ${m[1]} but has no numeric export const ${m[1]}`);
  return num(named[1]);
}

test("the MM and pricer defaults match keeper/src/v2/config.ts", () => {
  assert.equal(mirror.MM_FAIR_SPOT_TOLERANCE_BPS, configDefault("MM_FAIR_SPOT_TOLERANCE_BPS"));
  assert.equal(BigInt(mirror.MM_MAX_SPOT_AGE_S), configDefault("MM_MAX_SPOT_AGE_S"));
  assert.equal(BigInt(mirror.MM_OPEN_GRACE_S), configDefault("MM_OPEN_GRACE_S"));
  assert.equal(mirror.PRICER_EDGE_BPS, configDefault("PRICER_EDGE_BPS"));
  assert.equal(mirror.PRICER_REPRICE_THRESHOLD_BPS, configDefault("PRICER_REPRICE_THRESHOLD_BPS"));
});

test("PRICE_TICK matches keeper/src/v2/cranker/constants.ts", () => {
  const m = /^export const PRICE_TICK = ([0-9_]+)n;/m.exec(source("keeper/src/v2/cranker/constants.ts"));
  assert.ok(m, "keeper/src/v2/cranker/constants.ts has no PRICE_TICK");
  assert.equal(mirror.PRICE_TICK, num(m[1]));
});

test("the reader fails on a name the config does not have", () => {
  assert.throws(() => configDefault("MM_NO_SUCH_KNOB"), /no intField default for MM_NO_SUCH_KNOB/);
});
