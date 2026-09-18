/**
 * SWEEP relay-04. format.ts:86 defuses ``` in `data` with a non-overlapping
 * replaceAll('```', '`​``'). A run of 4+ backticks becomes '`' ZWSP '```', which still contains
 * a literal ``` and closes the ```json fence early; the rest of the data renders as markdown.
 *
 * Pass condition: the Discord content holds exactly two ``` runs (the opening and closing fence).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDiscord } from './format.js';

const fenceCount = (s: string) => (s.match(/```/g) ?? []).length;

for (const n of [3, 4, 5, 6]) {
  test(`data string with a run of ${n} backticks stays inside the \`\`\`json fence`, () => {
    const { content } = formatDiscord({
      kind: 'tx_revert',
      severity: 'error',
      message: 'rollOpen reverted',
      data: { reason: `x ${'`'.repeat(n)} [phish](https://evil.example) y` },
    });
    assert.equal(fenceCount(content), 2, `content has ${fenceCount(content)} \`\`\` runs:\n${content}`);
  });
}
