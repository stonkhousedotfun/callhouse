/**
 * devnet-mm.ts --safe-call, the parts that are pure text: the §5 rows the harness checks the live bot against
 * are the published rows, and the env keys the section resets are the ones its comment names.
 *
 * WHY TEXT, NOT AN IMPORT: devnet-mm.ts runs its harness at module load (it brings a devnet up), so importing it from a
 * test would start anvil. The constants are read from its source instead, and the doc's table from the doc.
 *
 * WHAT THIS CATCHES: a harness row copied wrong, or a doc table edited without the harness (or the other way round).
 * Either would make the live run compare the bot against numbers nobody published, and a green run would prove the
 * wrong thing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const HARNESS = readFileSync(new URL('./devnet-mm.ts', import.meta.url), 'utf8');
const DOC = readFileSync(new URL('../../../../docs/MM-SAFE-CALL-SELLING.md', import.meta.url), 'utf8');

interface Row {
  at: string;
  offsetS: number;
  strike: number;
  fair: number;
  lagFair: number;
  floorWrite: number;
  ask: number;
}

function harnessRows(): Row[] {
  const block = /const WORKED_ROWS = \[([\s\S]*?)\] as const;/.exec(HARNESS)?.[1];
  assert.ok(block, 'devnet-mm.ts has no WORKED_ROWS block');
  const rows: Row[] = [];
  const re = /\{ at: '(\d\d:\d\d)', offsetS: ([\d_]+), strike: ([\d.]+), fair: ([\d.]+), lagFair: ([\d.]+), floorWrite: ([\d.]+), ask: ([\d.]+) \}/g;
  for (const m of block.matchAll(re)) {
    rows.push({ at: m[1]!, offsetS: Number(m[2]!.replaceAll('_', '')), strike: Number(m[3]), fair: Number(m[4]), lagFair: Number(m[5]), floorWrite: Number(m[6]), ask: Number(m[7]) });
  }
  return rows;
}

/** §5's table: `| 12:00, K 232.50 | fair | lagFair | vol bump | v8 ask | ask | floor.write | ask / fair |`. */
function docRows(): Array<{ label: string; at: string; strike: number; fair: number; lagFair: number; ask: number; floorWrite: number }> {
  const section = /## 5\. Worked example([\s\S]*?)\n## 6\./.exec(DOC)?.[1];
  assert.ok(section, 'the doc has no §5');
  const out = [];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim().replaceAll('*', ''));
    const m = /^(\d\d:\d\d), K ([\d.]+)(.*)$/.exec(cells[1] ?? '');
    if (m === null) continue;
    out.push({ label: cells[1]!, at: m[1]!, strike: Number(m[2]), fair: Number(cells[2]), lagFair: Number(cells[3]), ask: Number(cells[6]), floorWrite: Number(cells[7]) });
  }
  return out;
}

test('every worked-example row the harness checks is a row the doc publishes, number for number', () => {
  const doc = docRows();
  const rows = harnessRows();
  assert.equal(rows.length, 5, 'the harness checks five rows');
  for (const r of rows) {
    // The plain rows only: the annotated ones (a stale print, another band, the band-0 control) are other scenarios.
    const d = doc.find((x) => x.at === r.at && x.strike === r.strike && !/print|MM_SPOT_LAG_BPS|band 0/.test(x.label));
    assert.ok(d, `the doc has no plain ${r.at} K ${r.strike} row`);
    assert.deepEqual({ fair: r.fair, lagFair: r.lagFair, floorWrite: r.floorWrite, ask: r.ask }, { fair: d.fair, lagFair: d.lagFair, floorWrite: d.floorWrite, ask: d.ask }, `${r.at} K ${r.strike}`);
  }
});

test('each row is driven at its own clock: offsetS is the row time after the 09:30 open', () => {
  for (const r of harnessRows()) {
    const [h, m] = r.at.split(':').map(Number) as [number, number];
    assert.equal(r.offsetS, (h * 60 + m - (9 * 60 + 30)) * 60, `${r.at}`);
  }
});

test('the inputs the rows are computed at are the doc\'s: spot 229.03, iv 0.45, askIv 0.45 x 1.10', () => {
  assert.match(DOC, /NVDA oracle spot 229\.03 = `\/fair` spot, 45 % vol/);
  assert.match(DOC, /0\.45 × 1\.10 =\s*0\.495/);
  assert.match(HARNESS, /const WORKED_SPOT = '229\.03';/);
  assert.match(HARNESS, /const WORKED_IV = 0\.45;/);
  assert.match(HARNESS, /const WORKED_ASK_IV_MARKUP = 1\.1;/);
});

test('the section runs at engine defaults: the widening and pull launch proposals are reset, and every safe-call knob too', () => {
  const list = /const SAFE_CALL_DEFAULTED = \[([^\]]*)\];/.exec(HARNESS)?.[1];
  assert.ok(list, 'devnet-mm.ts has no SAFE_CALL_DEFAULTED list');
  const keys = [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  for (const k of ['MM_EXPIRY_WIDEN_BPS', 'MM_PULL_MINUTES', 'MM_SPOT_LAG_BPS', 'MM_SPOT_LAG_STALE_BPS', 'MM_FAIR_FROM_SESSION', 'MM_WRITE_STOP_MINUTES']) {
    assert.ok(keys.includes(k), `${k} is reset to its default`);
  }
});
