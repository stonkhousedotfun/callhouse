# Runbook — relay + monitor go-live (O3-006)

Owner-run. It touches Railway and the operator alert channel. It never prints `RELAY_TOKEN`, a
Discord webhook URL, a Telegram bot token or a chat id. An agent does not run `--apply` and does
not read `~/.callhouse-keys`.

The relay turns keeper JSON into Discord and/or Telegram. The monitor is the process that pages
when a bot is down, a settlement is late, or an admin event happens. Deploy the relay first; an
apply of `monitor` (or `pricer` / `mm-bot`) without a live relay is `REFUSED` (O3-004).

| | `relay` | `monitor` |
|---|---|---|
| Image | `relay/Dockerfile` | `keeper/Dockerfile` (copies `ops/v2/monitor.mjs`) |
| Port | 8080 | none. No healthcheck, no public domain |
| Volume | none | `/data`, `RAILWAY_RUN_UID=0` |
| Replicas | 1 | **1** (two monitors page everything twice) |
| Secrets | `RELAY_TOKEN` and one target | none of its own; `ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}` |

Shell, from the app repo root:

```bash
PROD_P=9988a803-0b8f-4b0e-8ada-ba71e5a505ae
PROD_E=319fcb44-0e25-4367-947c-09351a349d2e
railway link -p $PROD_P -e $PROD_E
railway --version    # ≥ 5.47.2, or go-live-v2.sh refuses
probe() { railway ssh --service "$1" -- node -e "fetch('$2').then(async r=>console.log(r.status,(await r.text()).slice(0,4000))).catch(e=>console.log('ERR',e.message))"; }
```

`--ref` is a full 40-character reviewed commit SHA. Who supplies it: the owner.

---

## 1. Secrets, named, never embedded

Generate and paste. **Seal in the Railway UI immediately after each set.** UI path: service
`relay` → Variables → the name → ⋮ → Seal.

### 1.1 `RELAY_TOKEN` (required)

```bash
openssl rand -hex 32 | railway variables --service relay --skip-deploys --set-from-stdin RELAY_TOKEN
```

≥ 32 characters. Surrounding whitespace is trimmed. Put a copy in the password manager **before**
this pipe — there is no way to read a sealed variable back out of Railway. This runbook does not
print the value.

### 1.2 One target (required)

Either Discord **or** Telegram. Both is fine. Neither: the relay refuses to boot.

**Discord.** Discord → the operator channel → Edit channel → Integrations → Webhooks → New webhook
→ Copy webhook URL. The URL's path **is** the credential. Paste:

```bash
railway variables --service relay --skip-deploys --set-from-stdin DISCORD_WEBHOOK_URL
# then type the URL, Enter, Ctrl-D. Never put it on the command line.
```

**Telegram.** @BotFather → `/newbot` for an **operator** bot (never the notifier's user-facing bot,
never set a webhook on it). Add the bot to the operator chat. Chat id is `-100…` for a channel.
Who supplies the chat id: the owner, from `@userinfobot` or the Bot API `getUpdates` on a throwaway
laptop, not from this runbook.

```bash
railway variables --service relay --skip-deploys --set-from-stdin TELEGRAM_BOT_TOKEN
railway variables --service relay --skip-deploys --set-from-stdin TELEGRAM_CHAT_ID
```

Set `PORT=8080` if it is not already, so the private URL's port is fixed:

```bash
railway variables --service relay --skip-deploys --set PORT=8080
```

Do not set `TELEGRAM_API_BASE` except in tests.

---

## 2. Create and deploy `relay`

Empty Service named `relay` in the Railway UI of project `callhouse` production if it does not
exist (no repo, no image source — `go-live-v2.sh` refuses a connected source). Then:

```bash
ops/go-live-v2.sh --plan-gating --services relay
ops/go-live-v2.sh --ref <40-char SHA> --services relay          # DRY RUN
ops/go-live-v2.sh --apply --ref <same SHA> --services relay
```

UI: healthcheck path `/health`, timeout 60 s, draining 12 s, restart On Failure 10 retries,
replicas 1, **no public domain** (the callers are in this project;
`http://relay.railway.internal:8080/alert`). Seal every secret it set.

```bash
probe relay http://relay.railway.internal:8080/health
# 200 {"status":"ok","service":"callhouse-relay","targets":["discord"]}
# or "telegram", or both.  A boot failure names the missing variable, never its value.
```

---

## 3. The test-alert script

`ops/v2/test-alert.mjs` POSTs one `kind=boot` payload. It takes the token at a prompt, or from
`RELAY_TOKEN` with `--from-env`. It never prints the token or a webhook path.

**Rehearsal / local fake target** (no Railway, no real Discord):

```bash
printf '%s' "$REHEARSAL_TOKEN" | node ops/v2/test-alert.mjs --url http://127.0.0.1:18080/alert --token-from-stdin
# $REHEARSAL_TOKEN is ≥32 chars, supplied by the owner of the rehearsal stack, never printed here.
# Expect: 200 and delivered:["fake"] (or whatever the fake answers).
```

The rehearsal stack's fake target is whoever is bound to that URL; who supplies the port: the
owner of that stack. `node --test ops/v2/test-alert.test.mjs` is the mechanical version of this
(a local HTTP server, no network).

**Production.** The relay image does not contain `ops/v2/test-alert.mjs` (`relay/Dockerfile` copies
`relay/src` only). The keeper image copies `ops/v2/monitor.mjs`, not this script. Send the test
from a container that already has `ALERT_WEBHOOK` and `ALERT_WEBHOOK_TOKEN` — `cranker` after its
first apply, or `monitor` after section 4. Token is read from the environment, never typed:

```bash
railway ssh --service cranker -- node -e 'fetch(process.env.ALERT_WEBHOOK,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.ALERT_WEBHOOK_TOKEN},body:JSON.stringify({source:"callhouse-cranker",kind:"boot",severity:"info",message:"relay wiring test",data:{}})}).then(async r=>console.log(r.status,await r.text())).catch(e=>console.log("ERR",e.message))'
# 200 {"ok":true,"delivered":["discord"],"failed":[]}
# AND the message is visible in the channel. A 200 alone is not enough.
```

If `cranker` is not up yet, section 4's monitor probe is the first end-to-end proof.

`502` with `failed[].error` `http_401` / `http_404` on Discord: webhook URL wrong or deleted.
`http_400` / `http_403` from Telegram: wrong chat id, or the bot is not in the chat. The relay
logs `alert relayed` and `alert NOT delivered: every target failed` — never `target refused`.

---

## 4. Create and deploy `monitor`

Empty Service named `monitor` in the Railway UI (no repo, no image source). `go-live-v2.sh`
creates it if missing, mounts `/data`, sets `RAILWAY_RUN_UID=0`, the start command
`node ops/v2/monitor.mjs --interval 60`, `MONITOR_STATE_PATH=/data/monitor-v2.json`,
`ALERT_WEBHOOK=http://relay.railway.internal:8080/alert`,
`ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}`, and `MONITOR_HEALTH` from selected ∪ already-deployed
services that expose a health URL. An empty `MONITOR_HEALTH` is refused when `monitor` is selected.

```bash
ops/go-live-v2.sh --plan-gating --services monitor
# Will query Railway at --apply for existing services. --plan-gating does not.

ops/go-live-v2.sh --ref <40-char SHA> --services monitor          # DRY RUN
ops/go-live-v2.sh --apply --ref <same SHA> --services monitor
```

If the dry run says `MONITOR_HEALTH` is empty, deploy at least one health-exporting service first
(pricing, indexer-v2, relay, cranker, …) or pass them in the same `--services` list
(`--services relay,monitor` is valid once relay is live).

UI, after apply — the CLI cannot set these:

- replicas **1**
- **no healthcheck** (the process serves no port)
- **no public domain**
- volume mounted at `/data`
- start command `node ops/v2/monitor.mjs --interval 60`
- restart On Failure

```bash
railway ssh --service monitor -- ls -ld /data /data/monitor-v2.json
# /data is root-owned because RAILWAY_RUN_UID=0
railway logs --service monitor
# "summary: 0 finding(s) … exit 0" per pass, once caught up
```

---

## 5. Expected one-time pages on first run

The first run is not a quiet pass. Treat the following as **expected**, not as incidents, until a
second pass repeats them.

1. **Catch-up, no pages.** First run scans from `v2.deployBlock` (at most 200 ranges per pass, then
   continues). Exit **3** until caught up. Admin / guardian history before that moment is
   **adopted, not paged** (`v2_mon_config_changed` does not fire for the past).
2. **After catch-up, currently-true conditions page once.** Typical first-pass pages, depending on
   what is already up:

   | Kind | When it is expected | When it is not |
   |---|---|---|
   | `v2_mon_service_down` / `v2_mon_service_degraded` | `MONITOR_HEALTH` names a service not yet deployed, or still `starting` | that service's own `/health` is 200 `ok` and the name in `MONITOR_HEALTH` is wrong |
   | vault inventory / outflow kinds | MakerVault not yet funded (canary §3.4) | after 150 USDG + 1 NVDA is in the vault and `limits()` read back |
   | `v2_mon_state_unwritable` | `RAILWAY_RUN_UID` is not 0, or `/data` is missing | `ls -ld /data` is writable by the process |

3. **Delivery probe** (does not touch `/data/monitor-v2.json`):

   ```bash
   railway ssh --service monitor -- node ops/v2/monitor.mjs --once --state /tmp/probe.json --health probe=http://127.0.0.1:1/health
   # pages v2_mon_service_down for "probe" through the relay. Expect that page, once.
   ```

4. **Laptop, reads only, no state, no alerts:**

   ```bash
   node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts; echo "exit $?"
   # 0, every check [ok], once catch-up on the service is done. --rpc is a flag the monitor parses.
   ```

   `$RH_RPC` is `https://rpc.mainnet.chain.robinhood.com` unless the owner has a keyed URL. A keyed
   URL stays in the environment (`ETH_RPC_URL` / `RH_RPC`), never in argv.

**Nobody can page you about the relay through the relay.** The out-of-band signal is the process
dying: after `MONITOR_MAX_FAILED_PASSES` consecutive passes that reached nobody (default 3, about 3
minutes at `--interval 60`) Railway's deploy-notification email is the channel that reaches you.
Confirm that email address is one you read. Who supplies the address: the owner, in the Railway
project notifications settings.

---

## 6. What this runbook does not do

- It does not deploy `cranker`, `pricer` or `mm-bot`. Those are [v2-canary.md](v2-canary.md) §4.
- It does not choose Discord vs Telegram. Who chooses: the owner (OQ-08). This file names both
  variable sets; it does not pick.
- It does not print, rotate or recover `RELAY_TOKEN`. Lose the password-manager copy and you
  generate a new token, set it, seal it, and redeploy every `ALERT_WEBHOOK_TOKEN` reference
  (`go-live-v2.sh --apply --ref <SHA> --services <each caller>`).

## Related

- [`../deploy.md`](../deploy.md) §12, §15.12
- [`../go-live-v2.sh`](../go-live-v2.sh), [`v2-go-live-gating.md`](v2-go-live-gating.md)
- [`../v2/test-alert.mjs`](../v2/test-alert.mjs)
- [`../v2/monitor.mjs`](../v2/monitor.mjs)
- [`v2-canary.md`](v2-canary.md) §3.8, §4.1, §4.3, §4.5
- [`../alerts.md`](../alerts.md) Transport, §V14, §V17
