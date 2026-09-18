/**
 * SWEEP relay-07 (header half; the data half is relay-04). format.ts:83 puts `alert.message`
 * into the Discord header unescaped. A message containing ``` (for example a revert string or RPC
 * error text quoted into the message) opens a code block that swallows the context line and
 * turns the ```json opening fence into its close, so the data renders outside any block.
 *
 * Pass condition: the Discord content holds exactly two ``` runs (the data fence).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDiscord } from './format.js';

const fenceCount = (s: string) => (s.match(/```/g) ?? []).length;

test('a message containing ``` cannot open a code block in the Discord header', () => {
  const { content } = formatDiscord({
    kind: 'v2_tx_revert',
    severity: 'error',
    message: 'mm place send-failed: provider said ```execution reverted```',
    source: 'callhouse-mm-bot',
    chainId: 4663,
    data: { kind: 'place', key: 'NVDA-1' },
  });
  assert.equal(fenceCount(content), 2, `content has ${fenceCount(content)} \`\`\` runs:\n${content}`);
});

test('a context field containing ``` cannot open a code block in the Discord header', () => {
  const { content } = formatDiscord({
    kind: 'v2_tx_revert',
    severity: 'error',
    message: 'place failed',
    source: 'provider ``` error',
    data: { kind: 'place' },
  });
  assert.equal(fenceCount(content), 2, `content has ${fenceCount(content)} \`\`\` runs:\n${content}`);
});
