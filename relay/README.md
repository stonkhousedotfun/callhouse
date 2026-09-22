# @callhouse/relay

Turns the keeper's alert webhook into a Discord message and/or a Telegram message.

The keeper POSTs one JSON shape to `ALERT_WEBHOOK` (`keeper/src/alerts.ts`, documented in
`ops/alerts.md`). Discord and Telegram each want their own shape, and a raw Discord webhook URL
answers **400 to every keeper alert, forever**. This service sits between them: it checks a shared
token, validates the payload, formats it, and forwards it to whichever targets are configured.

One file per concern, no framework: `node:http`, `fetch`, and zod for validation (the same
approach as `keeper/src/config.ts`).

```
src/config.ts    environment → RelayConfig. Refuses to boot half-configured. Never echoes a secret.
src/payload.ts   the keeper payload schema (zod)
src/format.ts    alert → Discord { content ≤ 2000 } / Telegram { text ≤ 4096 }. Pure.
src/targets.ts   target POST with a deadline and one bounded 429 retry. Never logs a URL.
src/server.ts    GET /health, POST /alert, the status contract
src/log.ts       JSON lines, same shape as the keeper and the indexer
src/index.ts     boot + SIGTERM
```

## Quick start

```bash
pnpm install
RELAY_TOKEN=$(openssl rand -hex 32) \
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token> \
  pnpm --filter @callhouse/relay dev

curl -s localhost:8080/health
curl -s -X POST localhost:8080/alert \
  -H "Authorization: Bearer $RELAY_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"boot","severity":"info","message":"relay smoke test","data":{}}'
```

Gates (what CI runs):

```bash
pnpm --filter @callhouse/relay typecheck
pnpm --filter @callhouse/relay test
```

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `RELAY_TOKEN` | yes | Shared secret the keeper presents. Surrounding whitespace is trimmed before the ≥ 32 character check, matching the keeper. `openssl rand -hex 32` |
| `DISCORD_WEBHOOK_URL` | one target required | Discord channel webhook (Channel → Integrations → Webhooks). Its path is the credential |
| `TELEGRAM_BOT_TOKEN` | one target required | From @BotFather. Set together with `TELEGRAM_CHAT_ID` |
| `TELEGRAM_CHAT_ID` | with the bot token | The chat or channel id (`-100…` for channels). The bot must be a member |
| `RELAY_TIMEOUT_MS` | no | Per-target deadline. Default `5000`, maximum `9000` — the keeper aborts its own POST at 10 s |
| `TELEGRAM_API_BASE` | no | Default `https://api.telegram.org`. Exists so tests can point at a fake |
| `PORT` | no | Default `8080`. Railway injects it |

Configure Discord, Telegram, or both. With neither, the relay refuses to start: a relay with
nowhere to send is a misconfiguration and should look like one at boot, not at the first alert.
Blank values count as unset.

## HTTP

| Method | Path | Auth | Answers |
|---|---|---|---|
| GET | `/health` | none | `200 {"status":"ok","service":"callhouse-relay","targets":["discord",…]}` |
| POST | `/alert` | token | see below |

### Authentication

Either of:

```
Authorization: Bearer <RELAY_TOKEN>      preferred
POST /alert?token=<RELAY_TOKEN>          fallback for clients without headers
```

Compared in constant time (SHA-256 digests through `timingSafeEqual`), checked **before** the body
is read. The keeper sends the header when `ALERT_WEBHOOK_TOKEN` is set; use that. The query form remains
for clients that cannot set headers, but a query string can land in proxy access logs.

### Status contract

The keeper treats any non-2xx (or no answer in 10 s) as a failed delivery and retries that alert
in five minutes instead of suppressing it for the hour. So:

| Status | When | Keeper effect |
|---|---|---|
| **200** | at least one target accepted. Partial failures are listed in `failed` and logged at warn | delivered; full cooldown. Not retried, because a retry would duplicate the message where it did land |
| **502** | every configured target refused, was unreachable, or timed out | retried in 5 min |
| 400 | invalid request target, body is not JSON, or not a keeper alert (`issues` says which field) | retried, and will keep failing — read the relay log |
| 401 | missing or wrong token | retried, and will keep failing — fix `ALERT_WEBHOOK` |
| 413 | body over 256 KiB | retried, and will keep failing |

Response body: `{ ok, delivered: ["discord"], failed: [{ target, status, error }] }`. `error` is a
code (`http_429`, `timeout`, `ECONNREFUSED`), never a message or a URL. A target's first 429 is
retried once if its `retry_after` fits inside `RELAY_TIMEOUT_MS`; a repeated or too-late 429 is
reported as `http_429`.

### Validation

`kind` (lowercase snake_case), `severity` (`info | warn | error`) and a non-empty `message` are
required. `kind` is **not** an enum: the keeper and the relay deploy separately, and an alert of a
kind the relay has not heard of must still arrive. `message` has no length cap — long text is
truncated when formatted, never refused. `source`, `market`, `factory`, `vault`, `chainId`, `at` and `data` are shown
when present.

## Formatting

Discord (`content`, ≤ 2000 characters, `allowed_mentions: {parse: []}` so nothing in a message can
ping `@everyone`):

````
🔴 **ERROR** `tx_revert` rollOpen reverted on chain
vault 0x… · chain 4663 · 2026-09-12T20:00:00.000Z · callhouse-keeper
```json
{
  "kind": "rollOpen",
  "hash": "0x…"
}
```
````

Telegram (`text`, plain — no `parse_mode`, so nothing needs escaping — ≤ 4096 characters):

```
🔴 ERROR tx_revert
rollOpen reverted on chain
vault 0x… · chain 4663 · 2026-09-12T20:00:00.000Z · callhouse-keeper

data:
{ … }
```

🔴 error, 🟠 warn, 🔵 info. Telegram `info` messages set `disable_notification` so they arrive
silently. When a message is over the limit, `data` is truncated first (with
`… (truncated)`) and the header last.

## Secrets

Nothing logs a token, a webhook URL, a bot token, a request URL or a header. Failures are logged
as target name + status + error code. `server.test.ts` runs every success and failure path and
then asserts that none of the three test secrets appear anywhere in the captured log output (and
that assertion was checked to fail when a log line leaked the query string).

## Deploy

Railway service `relay`, `relay/Dockerfile`, `relay/railway.json`, repo root as the build context.
The full setting list and the keeper-side wiring are in `ops/deploy.md` §12 and
`ops/alerts.md` "Transport".

```bash
# from the repo root
docker build -f relay/Dockerfile -t callhouse-relay .
docker run --rm -p 8080:8080 -e RELAY_TOKEN=… -e DISCORD_WEBHOOK_URL=… callhouse-relay
```
