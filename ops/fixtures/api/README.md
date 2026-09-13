# ops/fixtures/api/

The wire contract between the indexer and the dapp, as files.

Each JSON here is one row of `GET /v1/cycles` exactly as `indexer/src/api/index.ts`
`cycleJson` emits it today, for the four outcomes a week can have:

| File | Week | What it pins |
|---|---|---|
| `cycle-idle.json` | #6, status `idle` | the registry opened the week and the vault sat it out: `wrote: false`, registry facts only, every vault column at its default, `settlement.closedAt` null. Nothing ever closes a skipped week, so the dapp settles it by the registry's `expiryTimestamp` |
| `cycle-filled.json` | #7, status `closed` | wrote 12, sold 12 at 4.000000 USDG: 48 gross, 2.4 to Overcall (5% per contract), 45.6 to the vault, 2.28 protocol fee (5% of the 45.6 premium), 43.32 net to depositors over 100 shares |
| `cycle-unfilled.json` | #8, status `unfilled` | wrote 12, listed 12, sold 0. Every money field is `0`, and the row is still complete — the most likely outcome, published as "unfilled, 0" |
| `cycle-assigned.json` | #9, status `assigned` | sold 12, 5 assigned at 190: 950 USDG of strike proceeds on top of the premium, 7 lots returned, 995.6 gross, 2.28 fee (5% of the 45.6 premium only; the 950 is never fee'd), 993.32 net |

Two tests hold the two ends of the contract to these bytes:

- `indexer/src/api/index.test.ts` builds the four rows as typed schema literals, runs
  `cycleJson`, and deep-equals the result against these files. It fails when the producer
  changes shape.
- `web/lib/api.test.ts` reads these files and runs `normaliseCycle`, asserting the exact
  base-unit integers, booleans and timestamps that `/activity` and `/` render. It fails when
  the consumer stops understanding the shape.

The shape itself: money is `{raw, decimals, formatted}` with `raw` the base-unit integer
(USDG is 6 decimals; the asset and the shares are 18), counts are decimal strings, and every
timestamp is ISO under `*At` with the registry's two also as seconds under `*Timestamp`.
Consumers read `raw`, never `formatted`.

## Regenerating

Only after a deliberate change to `cycleJson`, and only from the indexer test's own data:

```bash
CALLHOUSE_WRITE_FIXTURES=1 pnpm --filter @callhouse/indexer test
pnpm --filter @callhouse/web test
```

The second command is not optional. A regenerated fixture the dapp cannot read is the bug
these files exist to catch — the readiness audit found the dapp reading flat keys the indexer
never sent, and every paying week rendered as "unfilled, 0". Commit the fixture diff with the
producer change so the shape change is visible in review.

Deliberately absent: fixtures for `/v1/vault`, `/v1/account` and `/v1/listings`. Those routes
carry live chain reads that no fixture can stand in for, and the dapp does not use them for a
number a user acts on.
