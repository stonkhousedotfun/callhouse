# ops/keeper/markets — one environment file per factory keeper

Every market in [`ops/markets/tier1.json`](../../markets/tier1.json) with status `live`, `planned`
or `superseded-by-v2` has a file here, `<TICKER>.env`, holding the whole environment of that market's keeper
process except the hot key. The files are **generated** by [`ops/keeper-env.sh`](../../keeper-env.sh)
and committed; a hand edit is overwritten on the next run and flagged by `--check` before that.

The 34 `superseded-by-v2` markets (the per-market factory rollout was cancelled for v2) keep their
files exactly as they were rendered while `planned`, header included: no factory, and a keeper
booted on one exits 1, which is now the permanent answer. They stay for `solo:quote --factory none`
and so `--check` did not move when the status flipped. No factory keeper will be deployed for them.

```bash
ops/keeper-env.sh                     # render every live/planned/superseded market (35 files at the 2026-09-15 build)
ops/keeper-env.sh --tickers TSLA,AAPL # only these
ops/keeper-env.sh --check             # CI / pre-deploy: exit 1 if any file is missing, stale or differs
node ops/keeper-env.sh --check        # the same program; the file is bash and node at once
```

## What is in a file

| Key | From | Notes |
|---|---|---|
| `KEEPER_MARKET` | `ticker` | the label on every log line, alert and `/health` |
| `FACTORY` | `deployment.factory` | blank with a comment while the market is `planned`; the keeper exits 1 on it ("VAULT / FACTORY: at least one must be set"), which is correct until DeploySoloBatch writes the address into the registry |
| `ASSET`, `PRICE_FEED` | `asset`, `feed` | cross-checked against `factory.asset()` / `factory.priceFeed()` at boot; a mismatch exits 1 |
| `CLEARINGHOUSE`, `USDG`, `SEAPORT` | `shared.*` | our own Clear (`0x53d7…b9C6`), not Overcall's; also cross-checked |
| `KEEPER_PRICING_MODE` | `mode` | `vol` for every market but SGOV; `fixed` never touches Cboe |
| `KEEPER_VOL_URL`, `KEEPER_VOL_ROOT` | `cboe.url`, `cboe.root` | vol mode only |
| `KEEPER_STRIKE_OTM_BPS`, `KEEPER_MIN_ASK_USDG6`, `KEEPER_TARGET_DELTA`, `KEEPER_PRICE_EDGE_BPS`, `KEEPER_PREMIUM_MARGIN_BPS` | the hand-maintained v1 pricing fields | `minAskUsdg6` is `100000` (0.10 USDG) in the registry; this affects the v1 factory keeper only. The v2 MM bot reads `MakerVault.askFloor` and its own half-spread settings |
| `SOLO_WIND_DOWN` | `v1RunOff` | written (`=1`) only when the registry flag is `true`: v1 run-off, the keeper never sets a week or lists, still settles, and alerts `v1_drained` once when the factory is empty. No market has it at the 2026-09-15 build; flipping it is part of the owner-run v1 freeze |
| `KEEPER_DB_PATH` | `/data/keeper-<ticker>.db` | one SQLite file per market on the service's own volume |
| `KEEPER_PORT`, `PORT` | `8787` | Railway probes `$PORT` |
| `RH_RPC`, `RH_RPC_2`, `POLL_INTERVAL_MS`, `ALERT_WEBHOOK` | chain-wide defaults | the relay over Railway's private network |

The header carries the registry's `generatedAt` and `verifiedAtBlock` (compared by `--check`)
and a render timestamp (ignored by it), so re-rendering an unchanged registry is a no-op diff.

## What is deliberately NOT in a file

**`KEEPER_PK`.** Never. The hot key for `<TICKER>` lives in `~/.callhouse-keys/markets/<TICKER>.env`
(mode 600, one `KEEPER_PK=0x…` line, written by `ops/markets/derive-keeper-keys.sh` from the ops
mnemonic; BIP-44 index in `deployment.keeperKeyIndex`, address in `deployment.keeper`). It is
layered on at deploy time by [`ops/keeper-railway.sh`](../../keeper-railway.sh), which pipes it
into `railway variables --set-from-stdin KEEPER_PK` and never puts it on a command line, in a
temp file or in this repository. Seal it in the Railway UI afterwards.

**`VAULT`.** Never. The pooled cNVDA vault is closed; its keeper (Railway service `keeper`) runs
with `VAULT` and `WIND_DOWN=1` as its own separate process, and none of these files can make a
factory keeper enter the pooled roll. NVDA's file here is the NVDA **factory** keeper
(`0xc4A5…2BBb`, key index 1, the original single-market keeper), not the vault's.

## One service per market

Each file is one Railway service, `keeper-<ticker>` (`keeper-tsla`, `keeper-nvda`, …), one
replica, one `/data` volume, one hot key, one `KEEPER_MARKET`. The keeper is a single-market
process by design (the plan's "one process per market, env-driven, no multi-market refactor"):
its nonce, its SQLite memory and its `/health` are all per key and per factory, and two markets
in one process would share a nonce, a database and a heartbeat. Never point two services at the
same volume, the same key file or the same `KEEPER_DB_PATH`.

Local run of one market, for a dry quote (sends nothing):

```bash
KEEPER_ENV_FILE=ops/keeper/markets/TSLA.env pnpm --filter @callhouse/keeper solo:quote --factory none   # planned: launch-default policy
KEEPER_ENV_FILE=ops/keeper/markets/NVDA.env pnpm --filter @callhouse/keeper solo:quote                  # live: the real factory policy
```

`keeper/README.md` → "Environment" documents every key; `keeper/src/solo.ts` documents how the
week is priced from them.
