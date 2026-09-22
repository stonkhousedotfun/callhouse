/**
 * The three V2_MODULES tables are identical BY RULE. This is the rule.
 *
 * WHY THIS FILE EXISTS. keeper/scripts/gen-abis.mjs says in its own header that the same table lives in
 * indexer/scripts/gen-abis.mjs and web/scripts/gen-abis.mjs and that all three change together. Nothing
 * asserted it, so they drifted three ways in silence: keeper was missing earnVault, houseVault,
 * houseVaultFactory and stockZap entirely, web was missing the two House rows, and the two rows web DID
 * share with indexer listed their sources in the opposite order.
 *
 * AND EVERY `gen:abis --check` STAYED GREEN THROUGHOUT, because each one compares its own table to its own
 * output. A table that forgets a module agrees with the files it generated from that table, perfectly,
 * forever. keeper reported "19 files match ops/" and passed *because* its table did not know about the
 * four missing modules. That is the failure this test exists to make impossible: a check that cannot see
 * the thing it is checking.
 *
 * WHY A THREE-WAY COMPARISON AND NOT A SHARED MODULE. A single imported source of truth would be better
 * and is not available: the header records that the workspace has no cross-package imports, which is the
 * reason the table is copied in the first place. So the rule is enforced where it can be - by reading the
 * three files as text and requiring the table blocks to match byte for byte.
 *
 * WHY BYTE-FOR-BYTE AND NOT A SET OF NAMES. A name-set comparison would have passed on the source-order
 * drift that was actually there. web listed `["IEarnVault.json", "EarnVault.json"]` where indexer listed
 * them concrete-first, and `sources[0]` decides which artifact the generator calls canonical: web's
 * earnVault.ts carried the header "EarnVault.json is the frozen interface standing in until
 * IEarnVault.json is exported", which is exactly backwards - EarnVault.json is the concrete artifact and
 * it is published. Same ABI bytes, false provenance. Only a byte comparison catches that.
 *
 * DELIBERATELY NOT ASSERTED: the rest of each gen-abis.mjs. The three generators legitimately differ in
 * output directory and in what else they emit (the indexer also writes accessManagerRoles.generated.ts).
 * Only the V2_MODULES block is identical by rule, so only it is pinned.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GENERATORS = ['keeper', 'indexer', 'web'].map((pkg) => ({
  pkg,
  file: path.join(REPO, pkg, 'scripts', 'gen-abis.mjs'),
}));

/** The `const V2_MODULES = [ ... ];` block, verbatim. Throws rather than returning empty if it moves. */
function tableOf(file: string, pkg: string): string {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('const V2_MODULES');
  assert.notEqual(start, -1, `${pkg}: no 'const V2_MODULES' in ${file} — this test is pinned to that name`);
  const end = source.indexOf('\n];', start);
  assert.notEqual(end, -1, `${pkg}: V2_MODULES in ${file} has no closing '];'`);
  return source.slice(start, end + 3);
}

/** Module names in table order, used only to say WHICH row differs when the byte check fails. */
const namesOf = (table: string): string[] => [...table.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!);

test('the three V2_MODULES tables are byte-identical', () => {
  const tables = GENERATORS.map(({ pkg, file }) => ({ pkg, table: tableOf(file, pkg) }));
  const [reference, ...rest] = tables;
  assert.ok(reference, 'no generators found');

  const differing = rest.filter((t) => t.table !== reference.table);
  if (differing.length === 0) return;

  // Name the module AND the table, so the failure points at the row rather than at a byte offset.
  const refNames = namesOf(reference.table);
  const lines: string[] = [];
  for (const { pkg, table } of differing) {
    const names = namesOf(table);
    const missingHere = refNames.filter((n) => !names.includes(n));
    const extraHere = names.filter((n) => !refNames.includes(n));
    for (const n of missingHere) lines.push(`  ${n}: present in ${reference.pkg}, MISSING from ${pkg}`);
    for (const n of extraHere) lines.push(`  ${n}: present in ${pkg}, MISSING from ${reference.pkg}`);
    if (missingHere.length === 0 && extraHere.length === 0) {
      // Same names, different text: the source-order case that a name comparison would pass.
      const differs = refNames.filter((n) => {
        const cut = (t: string) => t.slice(t.indexOf(`name: "${n}"`)).split('},')[0];
        return cut(reference.table) !== cut(table);
      });
      for (const n of differs) lines.push(`  ${n}: same name in ${reference.pkg} and ${pkg}, DIFFERENT entry text (check sources order)`);
    }
  }
  assert.fail(
    `V2_MODULES has drifted between packages — the three tables are identical by rule ` +
      `(see the header of keeper/scripts/gen-abis.mjs), and gen:abis --check cannot detect this ` +
      `because each generator compares its own table to its own output:\n${lines.join('\n')}`,
  );
});

test('every table lists the same modules in the same order', () => {
  // A weaker restatement that fails with a readable diff when the byte check fails on ordering alone.
  const [first, ...rest] = GENERATORS.map(({ pkg, file }) => ({ pkg, names: namesOf(tableOf(file, pkg)) }));
  assert.ok(first);
  for (const other of rest) {
    assert.deepEqual(other.names, first.names, `${other.pkg} module order differs from ${first.pkg}`);
  }
});
