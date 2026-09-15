# ops/fixtures/api/

The wire contract between the indexer and the dapp, as files.

Each JSON here is one row of `GET /v1/cycles` exactly as `indexer/src/api/index.ts`
`cycleJson` emits it today, for the four outcomes a week can have under write on fill:

| File | Week | What it pins |
|---|---|---|
| `cycle-filled.json` | #7, status `closed` | listed 12, sold 12 at 4.000000 USDG in one fill, written 12 (one `CallsWritten`): 48 gross, all of it to the vault (one consideration item, no venue cut), 2.4 protocol fee (5% of the premium), 45.6 net premium to depositors over 100 shares (0.456 per share); `strikeProceedsUsdg` 0, so `creditedUsdg` equals `premiumNet`; 12 lots returned |
| `cycle-unfilled.json` | #8, status `unfilled` | listed 12, sold 0, and under write on fill written 0: `written.claimKey` null, `written.collateral` 0, `settlement.assetsReturned` 0. Every money field is `0`, and the row is still complete — the most likely outcome, published as "unfilled, 0" |
| `cycle-assigned.json` | #9, status `assigned` | sold 12, 5 assigned at 190: 950 USDG of strike proceeds on top of the premium, 7 lots returned. `harvest.grossUsdg` 998 = `premiumGross` 48 + `strikeProceedsUsdg` 950; `fee` 2.4 (5% of the 48 premium only; the 950 is never fee'd); `premiumNet` **45.6** and `premiumNetPerShare` 0.456 (premium only, identical to the filled week); `creditedUsdg` 995.6 and `usdgPerShare` 9.956 (everything credited to holders, strike proceeds included) |
| `cycle-stranded.json` | #10, status `stranded` | sold 12, 5 assigned, and the close could NOT redeem the claim (USDG paused): `RollClose` reported the real `contractsAssigned` 5 but zero legs, so `settlement.assignmentUsdg` and `assetsReturned` are 0 until `retryStrandedClaim` lands; `stranded: true`; `settlement.strand` is `{gen: "1", recovered: false, recoveredAt: null, recoveredTx: null}`; the 48 of premium that had landed was harvested (`premiumNet` 45.6, `strikeProceedsUsdg` 0) |

There is no `cycle-idle.json` any more. The vault numbers its own cycles (no registry), so a
week the vault never armed has no row at all; the pre-redesign `registry` group became `option`
(the armed Valorem type's window, `exerciseTimestamp` / `expiryTimestamp`), `written` gained
`claimKey`, `collateral`, `writeCount` and the write timestamps (one `CallsWritten` per fill),
`listing` lost its 95/5 split, and `settlement` gained `strand`.

### The `harvest` group: premium and strike proceeds apart

On an assigned week the closing harvest sweeps both the premium and the strike proceeds — the
USDG the assigned collateral was sold for. The strike proceeds are returned principal, not
yield, so the group publishes them apart:

| field | meaning |
|---|---|
| `grossUsdg` | everything swept: `premiumGross + strikeProceedsUsdg` |
| `premiumGross` | premium as harvested. Equals `fill.premiumGross` once every fill's USDG has been swept: there is no venue cut between the two |
| `strikeProceedsUsdg` | `RollClose.usdgFromAssignment` swept by the terminal harvest, plus the live shares' part of a recovered stranded claim on the retry's harvest; 0 unless assigned |
| `fee` | protocol fee, on `premiumGross` only |
| `premiumNet` | `premiumGross − fee`. **Premium only** |
| `creditedUsdg` | `premiumNet + strikeProceedsUsdg`: everything credited to holders |
| `premiumNetPerShare` | `premiumNet` per whole share, summed per sweep |
| `usdgPerShare` | `creditedUsdg` per whole share, summed per sweep (includes strike proceeds) |

**Changed by W-21 (2026-09-13):** `premiumGross`, `strikeProceedsUsdg`, `creditedUsdg` and
`premiumNetPerShare` were added, and `premiumNet` became premium only. Before, `premiumNet` was
`grossUsdg − fee`, which on an assigned week included the strike proceeds — that number is now
`creditedUsdg`. Every other field kept its name and its meaning. A consumer tells the two
shapes apart by the presence of `creditedUsdg`; `web/lib/api.ts` does exactly that and splits an
older payload by subtracting `settlement.assignmentUsdg`.

Two tests hold the two ends of the contract to these bytes:

- `indexer/src/api/index.test.ts` builds the four rows as typed schema literals, runs
  `cycleJson`, and deep-equals the result against these files. It fails when the producer
  changes shape.
- `web/lib/api.test.ts` reads these files and runs `normaliseCycle`, asserting the exact
  base-unit integers, booleans and timestamps that `/activity` and `/` render. It fails when
  the consumer stops understanding the shape.

The shape itself: money is `{raw, decimals, formatted}` with `raw` the base-unit integer
(USDG is 6 decimals; the asset and the shares are 18), counts are decimal strings, and every
timestamp is ISO under `*At` with the option's two also as seconds under `*Timestamp`.
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

Deliberately absent: fixtures for `/v1/vault`, `/v1/account`, `/v1/listings` and `/v1/strands`.
Those routes carry live chain reads that no fixture can stand in for, and the dapp does not use
them for a number a user acts on.
