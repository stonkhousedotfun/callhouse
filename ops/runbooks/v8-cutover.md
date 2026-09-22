# v8 service cutover (OWN8-05)

Deploy the v8 services from the cutover release with **new bot keys, none shared with v7 or with any
dev stack**, and know in advance which state resets when the deploy block changes. This is an
**owner** runbook: every command that changes anything is the owner's to run. The tooling it uses,
[`ops/v8/cutover-env.mjs`](../v8/cutover-env.mjs), is a dry run unless given `--execute` and a chain id,
and even then it only writes a local packet. It never touches a chain, Railway or a key.

It sits between two other owner steps: the v8 contracts are deployed and written back first
(`ops/markets/write-back-v8.mjs`, [`v8-launch.md`](v8-launch.md) §2), and v7 is frozen only after v8
verifies ([`v7-runoff.md`](v7-runoff.md), OWN8-04). The v7 cranker and indexer keep running **from
their v7 images with the v7 registry** (`ops/markets/v7-legacy.json`) until the last v7 series
expires. Nothing here redeploys a v7 service; do not point one at the v8 ref.

## Shell setup

```bash
export PATH="$HOME/.foundry/bin:$PATH"
# The v8 bot keys get their own directory. ~/.callhouse-keys/v2 is where the v7 bots' key files
# already live (cranker.env, pricer.env) and is NOT a default any more: derive-bot-keys.sh,
# go-live-v2.sh and ops/v8/cutover-env.mjs all default to the v8 directory now. This export is
# belt-and-braces, and the only thing that changes behaviour if you point it somewhere else.
export CALLHOUSE_V2_KEYS_DIR="$HOME/.callhouse-keys/v8"
```

No private key is exported, typed, pasted or passed as an argument anywhere in this runbook.

## 1. Preconditions

- The v8 write-back is committed: `ops/markets/tier1.json` has `v2.deployBlock`, every
  `v2.contracts` address, `v2.flywheel` and `shared.safes`, and `node ops/markets/build-markets.mjs --check`
  is green.
- `node ops/v2-env.mjs --check` is green: the committed `ops/v2/env/*.env` are the render of that
  registry. go-live-v2.sh sets Railway variables from those files and refuses assignment drift.
- The release SHA the services will be built from is reviewed and recorded (`--ref`).
- Every special expiry whitelisted on the live calendar still passes the T-479 window guard. The
  Clearinghouse reads the calendar **only** at series creation (`isValidExpiry` at
  `Clearinghouse.sol:528`, inside `createSeries`), so an instant whitelisted before that guard
  existed was never tested against it and nothing re-checks it later. Run this before the services
  come up:

```bash
CAL=$(jq -r '.v2.contracts.expiryCalendar' ops/markets/tier1.json)
FROM=$(jq -r '.v2.deployBlock' ops/markets/tier1.json)

# 1. DISCOVER the candidates from the log. `ts` is the indexed topic, so this is every instant the
#    admin has ever touched, whitelisted or removed.
cast logs --rpc-url "$RH_RPC" --from-block "$FROM" --to-block latest \
  --address "$CAL" 'SpecialExpirySet(uint40,bool)' --json \
  | jq -r '.[].topics[1]' | sort -u > /tmp/special-expiries.txt

# 2. For each, read the CURRENT state and, when it is still whitelisted, reproduce the guard from
#    the calendar's own views. `start` is the settlement window's opening instant
#    (SETTLEMENT_WINDOW = 1800, V2Constants.sol:44); the guard passes iff that instant is inside a
#    regular session and the expiry is at or before that day's close.
while read -r topic; do
  TS=$((topic))
  [ "$(cast call "$CAL" 'specialExpiry(uint40)(bool)' "$TS" --rpc-url "$RH_RPC")" = true ] || continue
  START=$((TS - 1800))
  OK=$(cast call "$CAL" 'isRegularSession(uint40)(bool)' "$START" --rpc-url "$RH_RPC")
  CLOSE=$(cast call "$CAL" 'closeOf(uint32)(uint256)' $((START / 86400)) --rpc-url "$RH_RPC")
  if [ "$OK" = true ] && [ "$TS" -le "$CLOSE" ]; then
    echo "ok      $TS  $(date -u -r "$TS" +%Y-%m-%dT%H:%M:%SZ)"
  else
    echo "REFUSED $TS  $(date -u -r "$TS" +%Y-%m-%dT%H:%M:%SZ)  isRegularSession(start)=$OK close=$CLOSE"
  fi
done < /tmp/special-expiries.txt
```

**Worked:** every line reads `ok`, or the log query returns nothing at all. **Nothing is the normal
result on a freshly deployed calendar** — it starts with no whitelisted instant — and an empty
output is a pass, not a skipped step: it is the evidence that the enumeration ran against the right
address.

**Failed:** any `REFUSED` line. That instant is whitelisted on chain but its settlement window does
not lie inside one regular session, which means the calendar's data and the T-479 guard disagree.
**Remedy:** un-whitelist it with `setSpecialExpiry(<ts>, false)` through the LISTING lane —
removal is never refused, unlike whitelisting (`ExpiryCalendar.sol:140-144`). **Then check whether
a series already exists on it**: series created before the removal keep their expiry, so a removal
alone does not undo one that was already used. If a series exists, stop and escalate rather than
proceeding — deciding whether the guard or the whitelisted instant is right is an owner call, not a
cutover-night judgement.

**Worked:** both checks print their green line and the registry's `v2.deployBlock` is a number above
v7's `65780341`.

**Failed:** `v2.deployBlock is null` (the write-back has not happened — stop here), a completeness
line naming a null slot (a half-written registry), or `v2-env --check: N problem(s)` (re-render with
`node ops/v2-env.mjs`, commit, re-run). A registry whose deploy block **is** `65780341` is a copy of
v7, not a v8 registry: stop.

## 2. Derive the v8 bot keys into the v8 directory

```bash
ops/v2/derive-bot-keys.sh               # cranker 60, pricer 61, quoter 62, guardian 63
node ops/markets/build-markets.mjs --check
```

The indices are fixed in `ops/v2/derive-bot-keys.sh`'s `BOTS` table (v7 used 50–52; v1 used 1, 2
and 10–43). The script writes each key to `$CALLHOUSE_V2_KEYS_DIR/<bot>.env` (mode 600) and only the
**address** into `v2.bots` of the registry. Commit the registry; never commit anything under
`~/.callhouse-keys`.

**Worked:** four lines `<bot>  index <n>  <VAR>  address 0x…  (written …/.callhouse-keys/v8/<bot>.env)`
and `registry updated: v2.bots / shared.guardian`.

**Failed:** `REFUSED: …/.callhouse-keys/v8/cranker.env holds a key that is not index 60 of this
phrase` means that file already holds a different key; the script refuses to overwrite one. A refusal
naming `…/.callhouse-keys/v2/…` instead means `CALLHOUSE_V2_KEYS_DIR` is exported at **v7's**
directory — unset it or point it at v8, since v8 is the default. **Do not delete the v7 file**: the
v7 run-off services still need it.
`index 0 of this phrase is …, not the registry admin` means the wrong wallet file.

## 3. The cutover check (dry run)

```bash
node ops/v8/cutover-env.mjs --keys-dir ~/.callhouse-keys/v8
```

It refuses, all at once, anything that would make the v8 services a copy of v7 or share a key:

| Refusal | What it means | What to do |
|---|---|---|
| `KEY REUSE <bot>: address 0x… already appears in the v7 stack — …v7-legacy.json v2.bots.cranker` | that v8 bot IS a v7 bot: the same key | derive again; check the wallet file and `CALLHOUSE_V2_KEYS_DIR` |
| `KEY REUSE <bot>: keyfile ~/.callhouse-keys/v2/<bot>.env … v7: v7-env/cranker.env` | the reference points at v7's key file | `--keys-dir` the v8 directory (Shell setup) |
| `KEY REUSE <bot>: mnemonic-index ops mnemonic index 60 … dev: ops/v2/env-dev/cranker.env:10` | a dev env names the v8 index as the source of its key | see the note below |
| `v2.bots.<bot> is null` | step 2 has not run | step 2 |
| `registry v2.deployBlock … is v7's own deploy block` / `names a v7 contract` | the registry is a copy of v7 | stop; the write-back is wrong |
| `ops/v2-env.mjs --check fails` | committed env is not this registry's render | re-render, commit, re-run |
| `reuse source … yields 0 …` / `is missing` | the check cannot see a stack it must compare against | fix the source path in `REUSE_SOURCES`; a blind check is not a pass |
| `UNCLASSIFIED deploy-block reader <file>:<line>` / `STALE RESET_RULES entry` | the code changed since the reset list was derived | classify it in `RESET_RULES` (a reviewed code change), then re-run §6 |

**Note on the dev env.** At the commit this runbook was written against, `ops/v2-env.mjs` renders the
production bot-key reference (`~/.callhouse-keys/v2/<bot>.env`, `ops mnemonic index 60/61/62`) into
`ops/v2/env-dev/cranker.env`, `pricer.env` and `mm-bot.env` even though `ops/markets/dev.json` runs on
anvil accounts. The tool refuses on it because that is exactly the reuse OWN8-05 forbids: a dev stack
told to load the v8 key. The fix is in the renderer, not here. `--bots` can restate references, but
it is not a way around this: the address check still runs, and skipping the index check should be a
recorded owner decision, not a workaround.

**Worked:** the last line is `DRY RUN clean: every check passed. Nothing written.` and exit 0.

**Failed:** `REFUSED: N problem(s)` and exit 1. Every problem is listed; fix all of them. A run that
prints nothing after `v8 bots:` has not been read: re-run and read it.

## 4. Write the cutover packet

```bash
node ops/v8/cutover-env.mjs --keys-dir ~/.callhouse-keys/v8 --execute --chain-id 4663 --out ~/cutover-v8
```

`--out` must be outside the repository and empty; the tool never overwrites. The packet holds the six
service env files as `ops/v2-env.mjs` renders them (`env/`), `bot-keys.txt` (per bot: the service, the
variable, the expected address and the key references — **no key**), `reset-state.txt` (§6) and
`MANIFEST.txt` (source SHA, registry sha256, deploy block, every file's sha256). Every file is read
back after it is written.

**Worked:** `written and read back: 9 file(s) in …/cutover-v8`, exit 0, and `MANIFEST.txt` names the
reviewed release SHA without `(DIRTY)`.

**Failed:** `REFUSED: …; nothing written` (the dry-run refusals, or `--execute needs --chain-id`,
`--chain-id 1 is not the registry's chain 4663`, `--out … is inside the repository`, `--out … is not
empty`), or `FAILED: … did not read back as written` — discard that directory and re-run into a new one.

## 5. Go live with the new keys

`ops/go-live-v2.sh` is the go-live script. It reads each key from `$CALLHOUSE_V2_KEYS_DIR/<bot>.env`
and refuses a key that does not derive to the registry's `v2.bots` address, so the directory from the
Shell setup matters here as well. The service order is `ops/v2/go-live-gating.mjs --print-order`;
bring up `relay` and `monitor` before the signing bots ([`v8-launch.md`](v8-launch.md) §4).

```bash
ops/go-live-v2.sh --services relay,indexer-v2,pricing,notifier,monitor                    # DRY RUN
ops/go-live-v2.sh --apply --ref <reviewed-SHA> --services relay,indexer-v2,pricing,notifier,monitor
ops/go-live-v2.sh --apply --ref <reviewed-SHA> --services cranker
ops/go-live-v2.sh --apply --ref <reviewed-SHA> --services pricer
```

`mm-bot` is **not** here: it goes live through OWN8-07 (limits set and read back before any funding,
[`v2-canary.md`](v2-canary.md)). `web` is last, and only with `--services web` named.

**Worked:** the dry run ends without a `REFUSED` line and lists the same variable assignments as the
packet's `env/`; each apply waits for `SUCCESS` and each probed `/health` answers 200.

**Failed:** `REFUSED: the registry's v2 deployment is not complete` (back to §1), a key-file refusal
naming `~/.callhouse-keys/v2/…` (`CALLHOUSE_V2_KEYS_DIR` is exported at v7's directory in this shell;
the default is v8), or a service stuck
deploying past its healthcheck timeout. Stop at the first failure; do not skip a service.

## 6. State that resets with the new deploy block

The list is **derived**, not remembered: `node ops/v8/cutover-env.mjs --reset-state` scans every source
file for a reader of the deploy block (`deployBlock`, `deploy_block`, `*START_BLOCK`, `startBlock`;
tests, fixtures, docs and `contracts/` excluded) and requires each file found to be classified. At the
commit this runbook was written against it found 448 lines in 66 files. The tool's output is
authoritative; this section is its summary.

| Resets | What resets | What a FAILED reset looks like |
|---|---|---|
| `keeper/src/v2/anchor.ts` (read by `keeper/src/v2/cranker/cranker.ts`, `keeper/src/v2/mm/quoter.ts`, `keeper/src/v2/pricer/pricer.ts`) | each signing mode's SQLite store on `/data` clears its cursors, adopted orders and done-marks on its first v8 boot | no `changed` anchor warning on a mode's first v8 boot; one on every boot; or an `unset` warning |
| `keeper/src/v2/cranker/steps.ts`, `keeper/src/v2/cranker/scanner.ts` | the cranker's log index starts at the v8 block; v7 series stay the v7 cranker's | the first index pass starts at block 0 or below the v8 block |
| `keeper/src/v2/mm/fills.ts`, `keeper/src/v2/mm/series-index.ts` | MM fill history and realised PnL (the daily loss stop's input) and the series cursor start at the v8 block | a first-day realised PnL that includes v7 fills |
| `indexer/lib/env.ts`, `indexer/ponder.config.ts`, `indexer/src/v2/pnl.ts`, `indexer/src/api/v2/markets.ts` | a fresh schema per deployment, re-indexed from `V2_START_BLOCK`; PnL history starts over; `/v2/config.deployBlock` moves | `/v2/config.deployBlock` is not the v8 block, or `/ready` never turns 200 |
| `notifier/src/rules/indexer.ts` | the notifier's deployment anchor changes: activity cursor and stored holdings are dropped; v7 holders get no further notices from it | no `deployment anchor changed; resetting activity cursor` log on the first tick |
| `ops/v2/monitor.mjs` | a new state file named after the v8 Clearinghouse; every change detector re-baselines | the state path still carries the v7 Clearinghouse, or `MONITOR_STATE_PATH` pins an old file |

Projections to regenerate and redeploy (no state of their own): `ops/v2/env/indexer-v2.env`
(`V2_START_BLOCK`), `web/lib/markets.generated.ts` (web must be **rebuilt**), the indexer's
`indexer/lib/v2/marketRegistry.generated.ts`, the launch packet and the market docs.

Not derivable, because nothing reads the block (the tool prints these under their own heading):
`DATABASE_VIEWS_SCHEMA=callhouse_v2` is one fixed name, so a v7 indexer kept for the run-off must not
share the v8 database; `/data` files survive (their content is reset, not the file); Railway variables
survive a redeploy; per-market `registeredAt` / `registerTx` / `v2.status` are reset by the write-back
and the OWN8-06 registrations.

**Worked:** `--reset-state` exits 0 and after the first boot of each service the log line in the
table's last column appears exactly once.

**Failed:** `--reset-state` exits 1 (`UNCLASSIFIED` or `STALE`: the list no longer matches the code),
or a service boots without its reset line.

## Known deploy traps

- **`RAILWAY_RUN_UID=0`** on every service with a `/data` volume (cranker, pricer, mm-bot, monitor).
  The image runs as `node` and Railway mounts volumes root-owned; without it the first boot logs
  `EACCES` on the SQLite file (`ops/deploy.md` §10.3). go-live-v2.sh sets it; any hand-run
  `railway variables` path must set it too.
- **`CALLHOUSE_V2_KEYS_DIR`** pointed at `~/.callhouse-keys/v2`: that is the v7 bots' directory, and
  go-live-v2.sh will refuse the v7 key because it does not derive to the v8 registry address. Unset
  is now correct — derive-bot-keys.sh, go-live-v2.sh and ops/v8/cutover-env.mjs all default to
  `~/.callhouse-keys/v8` (T-477, T-481). There is deliberately no fallback from v8 to v2: a missing
  v8 key file fails rather than silently loading a v7 key.
- **`DATABASE_SCHEMA` stays unset.** The indexer image indexes into a schema named after
  `RAILWAY_DEPLOYMENT_ID`; a fixed name crash-loops the second deploy (`ops/deploy.md` §11.3).
- **The registry is baked into the images.** A registry change is a rebuild from a new reviewed
  `--ref`, not a variable change. The web and indexer generated registries must be regenerated from the
  same registry before the build, or they ship the old addresses and block.
- **A stale Railway variable wins nothing but a refusal**: a `MAKER_VAULT` left on `mm-bot` from an
  older release stops the bot at boot (`keeper/src/v2/config.ts`). Delete it.
- **Earn and House are not rendered.** `ops/v2-env.mjs` renders no `V2_EARN_VAULT`, `V2_ZAP_HELPER`,
  `V2_HOUSE_VAULT_FACTORY`, `V2_EARN_START_BLOCK` or `V2_HOUSE_START_BLOCK`, which
  `indexer/lib/env.ts` reads: an indexer deployed by go-live-v2.sh does not index those contracts.
- **Signing bots are not redeployed between 15:40 and 16:20 New York time on a weekday** (the daily
  expiry snapshot window) unless `--ignore-expiry-window`.
- **`NOTIFIER_PUBLIC_URL` / `EMAIL_FROM` without `SMTP_URL`** crash-loop the notifier; they stay
  comments in `notifier.env`.
- **One replica per signing bot.** Two processes on one key race on its nonce; go-live-v2.sh refuses a
  service with more than one replica configured.

## Related

- [`v8-launch.md`](v8-launch.md) — the v8 launch canary this step belongs to
- [`v7-runoff.md`](v7-runoff.md) — OWN8-04, the v7 freeze that comes after v8 verifies
- [`incident-v2.md`](incident-v2.md) — bot-key rotation if a v8 key leaks
- [`../deploy.md`](../deploy.md) §15 — the go-live reference
