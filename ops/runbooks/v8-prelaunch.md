# OWN8-02 — the pre-launch services gate, in one command

`v8-plan/GO-LIVE-V7-SERVICES.md` section 6 lists four observable checks across a 383-line packet.
This runbook is the one command that reports all four, and what to do when one of them is red.

```
node ops/v8/prelaunch-gate.mjs \
  --evidence   ops/v8/prelaunch-evidence.json \
  --relay-url  http://relay.railway.internal:8080 \
  --pricing-url http://pricing.railway.internal:8790 \
  --indexer-url https://<that project's indexer> --long-id <a LIVE NVDA series> \
  --notifier-url https://dev-notify.stonkhouse.fun \
  --rpc "$RH_RPC" --chain-id 4663
```

One line per criterion, `PASS` or `FAIL`, and under each `FAIL` the exact next action. Exit 0 only
when all four are `PASS`; otherwise exit 1. `--json` prints the same rows as JSON. `--help` is exit 0.
`--timeout-ms <n>` bounds each HTTP read and is the only flag the parser accepts that the command
above does not show (`ops/v8/prelaunch-gate.mjs:75-78`, re-read 2026-09-21). `ops/v8/prelaunch-evidence.json`
does not exist in the repository: the operator writes it (see *The evidence file*), and an absent file
reads `FAIL` with a named reason, never as a skipped criterion.

## What this command will not do

It is read-only. It sends no test alert, opens no subscription, deploys nothing and writes to no
service. `--execute` exists only to be **refused**, with exit 2 — the refusal is covered by a test, so
the day someone adds a mutating path they have to delete that test first.

It never runs the owner action. Perform the actions in `GO-LIVE-V7-SERVICES.md` section 3, then
record what you saw in the evidence file, then run this to check them.

## The four criteria, and what a FAILED one looks like

### 1. `own8-02.relay.test-alert` — a test alert was received

**PASS** needs both: the relay answers `GET /health` 200, **and** the evidence file records a receipt
whose `status` is 200, whose `delivered` is non-empty, whose `failed` is empty, and whose
`seenInChannel` is `true`.

**FAILED looks like** one of:

| line | what it means |
|---|---|
| `relay …/health is unreachable: …` | the relay is not up, or not reachable from here. It refuses to boot with no target (`relay/src/config.ts:85-91`) |
| `the relay is up, but no test-alert receipt is recorded` | you have a live relay and no delivered message. These are different facts |
| `delivered is empty` | the relay returned 200 and forwarded to nobody. `GO-LIVE-V7-SERVICES.md:330` is explicit: "A 200 alone is not enough" |
| `failed is ["telegram"]` | one target rejected it. A partial delivery is not a delivery |
| `seenInChannel is not true` | nobody has attested the message was visible on a screen. The tool cannot see a Discord channel and will not pretend to |

Do not edit the receipt to make the line green. Re-send the alert — the cranker one-liner at
`ops/runbooks/v2-canary.md:850` (`railway ssh --service cranker -- node -e 'fetch(process.env.ALERT_WEBHOOK, …)'`;
the `:791-792` this used to cite, and which `GO-LIVE-V7-SERVICES.md:330` still cites, is now the
Railway-UI sealing paragraph) — and record the real body.

### 2. `own8-02.monitor.once-clean` — `monitor --once` is clean

Runs `node ops/v2/monitor.mjs --once --no-alerts --json --rpc <rpc>` and reads its JSON report.
`--no-alerts` is what keeps this read-only.

**"Clean" is not "exit 0"** while KeeperRewards and MakerVault hold 0. It is **exit 1 carrying exactly
`v2_mon_rewards_budget_low` and `v2_mon_vault_inventory_low` and no third name**
(`GO-LIVE-V7-SERVICES.md:331`). Exit 0 with no alerts also passes, for the day those clear. A third
name is a finding to chase, never an allowlist entry — and since T-OP-083 one such name is
`v2_mon_oracle_halted`, which means a launch-set Stock Token (NVDA, SPCX) is halted right now; that is
a correct red, not noise (`ops/alerts.md` §V30a).

**FAILED looks like** one of:

| line | what it means |
|---|---|
| `fired N name(s) beyond the two known standing pages: <names>` | a real finding. Triage each name; do not add it to the allowlist to clear the gate |
| `fired a subset of the standing pages … missing <name>` | the standing set changed. Re-derive the allowlist from the packet, do not widen it |
| `reported N incomplete check(s)` | a check could not run, so it has **no findings to show**. Silence from a check that did not run is not health. `exitCodeFor` in `ops/v2/monitor.mjs:3787-3789` ranks this (exit 3) above a finding (exit 1) |
| `reported N delivery failure(s)` | the monitor's own alerts are not reaching the relay. Distinct from criterion 1, which is about the relay itself |
| `the exit and the summary disagree` | the monitor's alerting changed shape. Re-derive before trusting either number |
| `--chain-id N is not 4663` | a clean pass against the wrong chain proves nothing |
| `the monitor did not run` / `could not be parsed` | **not** a clean monitor. An empty alert list that was never produced is the exact false green this gate exists to refuse |

### 3. `own8-02.pricing.fair` — `/fair` answers for a live NVDA series

**PASS** needs pricing `/health` 200 with `status: ok`, **and** `GET /v2/fair/<longId>` on that
project's indexer returning a Money carrying both `source` and `asOf`.

`PRICING_URL` being set is deliberately **not** a criterion — a config value is not behaviour. The
observation is the answer.

**FAILED looks like** one of:

| line | what it means |
|---|---|
| `the indexer answered "Pricing service is not configured"` | `PRICING_URL` is unset on the indexer serving that host (`indexer/src/api/v2/markets.ts:442`, `ops/v2/env/indexer-v2.env:74`). Set it and redeploy that indexer |
| `pricing /health answered 200 but status is "degraded"` | the service is reporting its own unhealth. A 200 is the envelope, not the verdict |
| `answered 200 but without source and asOf` | a price with no provenance. That is the delayed-data risk at `GO-LIVE-V7-SERVICES.md:350`, not a pass |
| `answered 404` | check the long id names a **live** series. An expired series is not a pricing failure |

Judge this **in session**. Out of hours a correct pricing service answers like a broken one.

### 4. `own8-02.notifier.daily-expiry` — real alerts through one daily expiry

**PASS** needs notifier `/health` 200 with `status: ok`, **and** an evidence record showing Telegram
**and** a browser subscription each received `reminder1h`, `settlementReceipt` and `fillReceipt`
exactly once, with `breakerOpened: false`, `rulesStatus: "ok"` and `xffTestPassed: true`
(`F4-notifications.md:36`, `:83`).

**FAILED looks like** one of:

| line | what it means |
|---|---|
| `the notifier is up, but no daily-expiry soak is recorded` | a healthy notifier is not a delivered alert |
| `browser is missing fillReceipt` | one channel did not get one message. Both channels, all three messages |
| `received … more than once` | production is gated on each expected message arriving **once** |
| `breakerOpened is not false` / `rules.status is …` / `XFF test is not recorded as passed` | the soak's own gates. Re-run it |

The earliest daily expiry is 16:00 New York; the packet names Monday 2026-09-21
(`GO-LIVE-V7-SERVICES.md:333`). That date has passed at the time of this re-verification (2026-09-21,
evening PT) without a recorded soak; the criterion needs the next New York trading day's 16:00 expiry.

## The evidence file

Two of the four criteria are facts about a human's screen — a message visible in a channel, a push
notification on a phone. The tool records them rather than inferring them:

```json
{
  "testAlert":   { "status": 200, "delivered": ["discord"], "failed": [], "seenInChannel": true, "at": "<iso>" },
  "dailyExpiry": { "telegram": ["reminder1h","settlementReceipt","fillReceipt"],
                   "browser":  ["reminder1h","settlementReceipt","fillReceipt"],
                   "breakerOpened": false, "rulesStatus": "ok", "xffTestPassed": true, "expiry": "<iso>" }
}
```

A missing file, an unreadable file and malformed JSON are each reported with a named reason, and the
criteria that depend on them still read `FAIL`. There is no path where an absent evidence file makes
a criterion disappear.

## Where this sits in the verification catalog

`ops/v8/gates.json` carries one row, `app.prelaunch-gate`, which runs **this tool's test suite** —
not the tool. The suite needs no services. The tool needs live endpoints that a verification pass has
no bindings for and must never reach.

That row declares **no preconditions on purpose**. `verify-gates.mjs` turns an unmet precondition into
a `REFUSED`, and this gate's whole design is that an unconfigured service reads `FAIL`. Declaring one
would convert its loudest signal into a refusal.

## Tests

```
node --test ops/v8/prelaunch-gate.test.mjs
```

The green control is asserted first: a gate proved only by its refusals may be refusing everything.

## Provenance

Re-verified by `T-OP-095` (claude-615885) on 2026-09-21 at callhouse `eab902369ef5d97a400d6d32fb263beafc39e8f4`.
Every flag in the command block is one `ops/v8/prelaunch-gate.mjs` parses (`--evidence --relay-url --pricing-url
--indexer-url --long-id --notifier-url --rpc --chain-id --json --help`, plus `--timeout-ms`); the four criterion
ids are the tool's (`:158`, `:201`, `:265`, `:317`, listed at `:363-366`); every FAILED line quoted above was
re-read at its `fail(...)` / `problems.push(...)` site, the pricing ones paraphrased (`answered 404, not 200`,
`status is "degraded", not "ok"`, `--chain-id N is not 4663` at `:207`); the monitor invocation is
`--once --no-alerts --json --rpc` (`:483`); `relay/src/config.ts:85-91` is the no-target refusal; `gates.json`
carries `app.prelaunch-gate` with `preconditions: []` and the note saying why (`:977-996`). Scratch runs, both
read-only: `node ops/v8/prelaunch-gate.mjs --help` (exit 0) and `--execute` (exit 2, the refusal text). Not run:
`ops/v8/prelaunch-gate.test.mjs`, any live endpoint, any network read; `gates: NOT RUN (owner directive
2026-09-21 23:05Z)`. Three line citations were STALE and are corrected above (`v2-canary.md:850`,
`monitor.mjs:3787-3789`, `markets.ts:442` / `indexer-v2.env:74`); the rest were TRUE.
