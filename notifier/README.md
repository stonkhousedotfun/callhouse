# @callhouse/notifier

User notifications for Stonkhouse v2: a wallet subscribes by signing a challenge, picks channels
(Telegram, Web Push, email) and alert kinds, and gets receipts, warnings and countdowns about its
own positions. `relay/` is a different thing (operator alerts to the team) and stays that way.

The HTTP contract is `02-interfaces.md` §6 of the Stonkhouse v2 plan. N2-01 built subscriptions,
auth, channels and delivery; N2-02 added the rules engine (`src/rules/`), which polls the indexer
API v2 and decides WHAT to send through `enqueue` below.

```
src/config.ts          environment → NotifierConfig. Refuses to boot half-configured. Never echoes a value.
src/auth.ts            challenge text, single-use nonces, EIP-191 + ERC-1271/6492 signature checks
src/session.ts         v5 settings sessions: stateless 30-minute bearer tokens, Authorization header parsing
src/server.ts          the HTTP API (Hono)
src/delivery.ts        enqueue() and the worker: dedupe, retries, rate limit, circuit breakers
src/events.ts          the §6 event kinds and their payload schemas (the N2-02 contract)
src/templates.ts       one plain-text message per event kind (copy rules pinned by templates.test.ts)
src/prefs.ts           subscription preferences and which kinds they let through
src/channels/          telegram.ts (Bot API + bot), webpush.ts (VAPID), email.ts (SMTP, double opt-in)
src/store.ts           subscription / nonce / telegram_link SQL
src/db.ts              pg adapter, migration runner
src/crypto.ts          AES-256-GCM targets at rest, lookup HMACs, link tokens
src/breaker.ts         per-channel circuit breaker
src/format.ts          numbers and times formatted like the dapp (web/lib/format.ts)
src/rules/engine.ts    the poller: one tick = read indexer, build snapshot, run rules, enqueue, persist
src/rules/rules.ts     the rules, pure functions over before/after snapshots (the kind table is its header)
src/rules/indexer.ts   /v2 client: deadlines, zod shapes mirroring web/lib/v2/api-schema.ts
src/rules/snapshot.ts  holdings, settlements, derived strike sides and alert states
src/rules/store.ts     cursor, snapshot and holdings SQL; the watch set
src/rules/calendar.ts  New York dates; session days as /v2/calendar/holidays reports them
src/app.ts, index.ts   wiring, boot, SIGTERM
migrations/*.sql       schema "notifier", applied at boot (001 subscriptions/delivery, 002 rules state, 003 abuse budgets)
```

## Quick start

```bash
pnpm install
DATABASE_URL=postgres://localhost:5432/notifier \
INDEXER_URL=http://localhost:42070 \
RH_RPC=https://rpc.mainnet.chain.robinhood.com \
NOTIFIER_DATA_KEY=$(openssl rand -hex 32) \
TELEGRAM_BOT_TOKEN=<from @BotFather> \
VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… \
APP_URL=http://localhost:3000 VAPID_SUBJECT=mailto:you@example.com \
  pnpm --filter @callhouse/notifier dev

curl -s localhost:8791/health
```

VAPID keys: `node -e "const w=require('web-push');console.log(w.generateVAPIDKeys())"` from this
directory, once; they are permanent (every browser subscription is bound to the public key).

Gates (what CI runs, job `notifier`):

```bash
pnpm --filter @callhouse/notifier typecheck
pnpm --filter @callhouse/notifier build
pnpm --filter @callhouse/notifier test
```

The tests need no database: storage runs on PGlite (real Postgres in WASM, in-process). To also run
the storage suite through the production `pg` adapter against a real, disposable Postgres:
`NOTIFIER_TEST_DATABASE_URL=postgres://… pnpm --filter @callhouse/notifier test` (it drops schema
`notifier` in that database).

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. The notifier owns schema `notifier` and touches nothing else |
| `INDEXER_URL` | yes | Indexer API v2, polled by the rules engine (N2-02) |
| `RH_RPC` | yes | Only for ERC-1271 / ERC-6492 (contract wallet) signature checks, 5 s deadline |
| `NOTIFIER_DATA_KEY` | yes | 32 bytes hex (`openssl rand -hex 32`). Encrypts stored targets; keys lookups and email links. Losing it orphans every target; rotation is not built |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather. The bot long-polls, so no webhook may be set on it |
| `TELEGRAM_API_BASE` | no | Default `https://api.telegram.org`. For the tests' fake |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | yes | base64url P-256 pair; checked to match at boot |
| `VAPID_SUBJECT` | when `APP_URL` is not https | `mailto:` or `https:`; default `APP_URL` |
| `SMTP_URL` | no | `smtp://` or `smtps://`. Unset = email channel off |
| `EMAIL_FROM` | with `SMTP_URL` | `Stonkhouse <alerts@…>` |
| `NOTIFIER_PUBLIC_URL` | with `SMTP_URL` | This service's public origin; confirmation and unsubscribe links point here |
| `APP_URL` | yes | The dapp origin. Messages link into it; the only CORS origin |
| `PORT` | no | Default `8791`. Railway injects it |
| `RULES_ENABLED` | no | Default `true`. `false`/`0` stops the rules engine (API and delivery keep running) |
| `RULES_POLL_S` | no | Default `30` (5-3600). Seconds between rules ticks |

`VAPID_SUBJECT`, `EMAIL_FROM`, `NOTIFIER_PUBLIC_URL`, `RULES_ENABLED` and `RULES_POLL_S` are additions to §7
of the plan. `INDEXER_URL` must serve `/v2/*` (an indexer without `V2_CLEARINGHOUSE` answers 404 there, and
`/health` then shows `rules.status: failing`).

### `/health` statistics (for the monitor)

- `delivery.lastHour` counts the deliveries **created** in the last hour by what became of them:
  `sent`, `failed`, `dropped`, and `rateLimited` (the subset of `dropped` a class budget refused,
  reason `rate_limited:<class>`). Rows still pending or retrying are in none of them. The whole
  object is `null` when the database did not answer, so a zero always means "none", never "unknown".
- `rules.watchSet` is the number of wallets with a verified, enabled subscription (the monitor warns
  at 400). `rules.oldestRefreshAgeS` is how many seconds ago the least recently refreshed wallet's
  positions were read, or `null` when the engine has read none yet. Both come from the tables, so
  they are reported whether or not a tick has run in this process.

## HTTP

All errors are `{ "error": { "code", "message" } }`. Times are unix seconds.

> **INTERFACE_VERSION 5** (notifier §6 only): `POST /v1/session` and `Authorization: Bearer <token>` on
> the four authenticated routes, so the settings page signs once per 30 minutes instead of once per
> action. The signature-per-request form below still works unchanged.

| Method | Path | Auth | Answers |
|---|---|---|---|
| GET | `/health` | none | `200 { status: ok\|degraded, service, database, channels: { telegram, webpush, email: closed\|open\|half-open\|off }, telegramBot, delivery: { lastHour: { sent, failed, dropped, rateLimited } \| null }, rules: { status: off\|starting\|ok\|failing, lastSuccessAt, consecutiveFailures, watchSet, oldestRefreshAgeS } }` |
| POST | `/v1/challenge` | none | `{ address }` → `{ message, nonce, expiresAt }` |
| POST | `/v1/session` | body (signature only) | `{ address, signature, nonce }` → `200 { token, address, expiresAt }` (v5; 30 min, no refresh) |
| POST | `/v1/subscriptions` | bearer, or body | `{ address, signature, nonce, channel, target, prefs }` → `201 { id }` new, `200 { id }` updated; with a bearer `{ address?, channel, target, prefs }` |
| GET | `/v1/subscriptions` | bearer, or query | `?address&signature&nonce` (bearer: `?address` optional) → `{ items }` |
| DELETE | `/v1/subscriptions/:id` | bearer, or query or JSON body | → `{ ok: true }`, `404` if not this wallet's. A bearer alone is enough |
| GET | `/v1/telegram/link` | bearer, or query | → `{ deepLink, expiresAt }` (`https://t.me/<bot>?start=<token>`, 15 min, single use) |
| GET | `/v1/webpush/key` | none | → `{ publicKey }` (the `applicationServerKey`) |
| GET/POST | `/v1/email/confirm?token` | token | double opt-in page / confirm |
| GET/POST | `/v1/email/unsubscribe?token` | token | unsubscribe page / one-click unsubscribe (RFC 8058) |
| POST | `/v1/email/resubscribe` | unsubscribe token from a received email | inbox owner allows new confirmation requests; the wallet must then subscribe again |

### Authentication

`POST /v1/challenge` returns an EIP-4361 message bound to `APP_URL`'s host and chain 4663; the wallet signs it with `personal_sign` and the
next call carries `address`, `signature`, `nonce`. Every call spends its nonce (10-minute expiry,
single use, bound to the address), so without a session the settings page signs once per action
(with one, once per 30 minutes: see Sessions below). The whole request is
validated first; only then is the nonce spent. Valid EOA signatures verify locally. A mismatched
ordinary ECDSA signature checks account code (cached for one minute); only contract accounts
reach `publicClient.verifyMessage`. ERC-1271 and valid ERC-6492 wrappers keep their chain path.

#### Sessions (v5)

`POST /v1/session { address, signature, nonce }` runs exactly that check (it spends the nonce) and
answers `200 { token, address, expiresAt }`: `address` checksummed, `expiresAt` 30 minutes out. Send
the token as `Authorization: Bearer <token>` on `GET /v1/subscriptions`, `POST /v1/subscriptions`,
`DELETE /v1/subscriptions/:id` and `GET /v1/telegram/link`:

- the wallet is the token's; `address` in the query or body may be left out, and when sent it must
  equal the token's address (any case), else `403 forbidden`;
- `signature` and `nonce` are not needed. If they are sent too, the bearer wins and the nonce is
  not spent (it still works once without the bearer);
- `DELETE` needs nothing but the bearer;
- a bearer on `/v1/session` is ignored: a new session always takes a new signature, so there is no
  refresh. When a call answers `401 session-invalid`, sign a new challenge and open a new session.

The token is opaque to clients: keep it in memory, never in browser storage, and do not parse it.
It is stateless (nothing stored): `v1.<checksummed address>.<expiresAt>.<HMAC-SHA256 base64url>`,
the MAC keyed by a key derived from `NOTIFIER_DATA_KEY` under the fixed label
`callhouse-notifier/sign/session/v1` (never the data key itself) and compared in constant time.
There is no revocation short of rotating `NOTIFIER_DATA_KEY` (which orphans stored targets). Any
non-blank `Authorization` header that is not a valid `Bearer` token is a `401 session-invalid`;
without the header the signature fields are required as before. CORS admits the `authorization`
request header from `APP_URL`.

| Status | code | Meaning |
|---|---|---|
| 400 | `bad-request`, `target-invalid`, `channel-unavailable` | fix the request; the nonce is still good |
| 401 | `nonce-invalid` | unknown, used, expired or another address's nonce: get a new challenge |
| 401 | `signature-invalid` | the signature is not the address's over that challenge |
| 401 | `session-invalid` | the bearer is expired, malformed, forged or from another data key: open a new session |
| 403 | `forbidden` | the bearer belongs to a different address than the `address` sent |
| 503 | `verifier-unavailable` | a contract wallet could not be checked (RPC): retry with a new challenge |
| 502 | `email-send-failed` | the confirmation email did not go out; POST again |
| 429 | `challenge-rate-limited` | challenge quota reached; retry after one minute |
| 429 | `subscription-limit` | the wallet already has 10 Web Push endpoints; remove an old one |
| 429 | `email-recipient-rate-limited` | the inbox has received three confirmation mails today |
| 429 | `email-confirmation-rate-limited` | this wallet or the service reached its daily confirmation send budget |
| 429 | `email-subscription-limit` | this wallet already has 10 enabled email subscriptions |

### `target` per channel

| channel | target | verified when |
|---|---|---|
| `webpush` | `PushSubscription.toJSON()` (object or JSON string); HTTPS endpoint on an approved browser push service | at once |
| `email` | the address | the owner POSTs the confirmation link's form (double opt-in) |
| `telegram` | omit it | the bot receives `/start <token>` from `GET /v1/telegram/link` |

A wallet has at most one Telegram subscription: POST with `channel: "telegram"` sets its prefs
(creating it unlinked if needed); the deep link attaches or moves the chat. A new deep link
invalidates the wallet's earlier unused links, keeping one pending link row. Web push and email are
keyed by endpoint / address, so a repeat POST updates prefs on the same row.

### Abuse bounds

Challenges are capped at 20 per wallet per minute in the database, with a per-wallet advisory
lock across replicas. A 120 per client per minute gate rejects bursts before they take a database
connection. The gate uses the last valid `X-Forwarded-For` hop from trusted ingress; deployment
must ensure the proxy appends that hop and direct public access to the service is closed. This
gate is process local, so configure an ingress rate limit as well for multi-replica deployments
and clients rotating source IPs. A wallet may have at most 10 active Web Push endpoints. Updating an active endpoint is
allowed; disabled endpoints do not consume a slot and are removed when a new endpoint is added.
Delete an old active subscription before adding another device at the cap.

Email confirmation is limited to one send attempt per subscription per 10 minutes, three per
normalized inbox per UTC day across wallets, ten per wallet per UTC day, and 1,000 service-wide
per UTC day. Gmail and Googlemail budgets fold dots and plus tags; delivery still uses the exact
address entered. An unsubscribe suppresses new confirmation mail to that normalized inbox until
its owner POSTs `/v1/email/resubscribe` with a token from an earlier email, then requests a new
confirmation from Settings. Failed sends retain their reservations:
an SMTP timeout may occur after the server accepted the email. Double opt-in still prevents alerts
before the inbox owner confirms. The subscription upsert and confirmation reservation commit in
one transaction: a rejected budget or suppression leaves no new pending row for that wallet.

These application quotas bound challenge creation, confirmation sends and Web Push delivery fanout.
Public ingress should also have an IP or client based rate limit: an attacker can rotate wallet
addresses and targets to create many distinct subscriptions over time. Web Push accepts only FCM,
Mozilla, Apple and Windows push-service hosts in `src/channels/webpush.ts`. This prevents wildcard
DNS names that resolve to private addresses from being stored. Review the host list when adding
browser support. Deployment egress policy should still restrict outbound connections to those
services on port 443; TLS hostname checks and redirect refusal also remain in force.

### `prefs`

`{ strikeCross, expiry24h, expiry1h, settlement, fills, writerItmWarning, autoRoll, priceAlerts }`.
Missing toggles default to on, `priceAlerts` to `[]`, unknown keys are a 400. A price alert is
`{ ticker, above?, below? }` with prices in USDG base units per whole share (`"221500000"` =
221.50 USDG), at most 20. `payout_failed_to_ledger` follows `settlement`.

A `ticker` that is not in the rules engine's last `GET /v2/markets` read is refused with the same
400 `bad-request` shape as any other `prefs` problem (`prefs: priceAlerts.<i>.ticker: <T> is not a
market on this notifier`), because an alert on a ticker the indexer does not list can never fire.
The check **fails open**: while no market list has been read (rules engine off, first tick not done,
indexer down), every ticker is accepted rather than every alert refused.

### List item

```json
{ "id": "…", "channel": "webpush", "status": "active", "target": "fcm.googleapis.com",
  "prefs": { … }, "createdAt": 1789592400, "verifiedAt": 1789592400, "disabledAt": null,
  "disabledReason": null }
```

`status` is `active | pending | disabled`. `target` is a hint only: the push service host, a masked
email (`h***@example.com`), `null` for Telegram. `disabledReason` is a code: `http_410` (browser
unsubscribed), `http_403` (bot blocked), `telegram_stop`, `email_unsubscribe`, `smtp_550`.

### Web Push payload (for the service worker)

```json
{ "title": "Bought NVDA 221.00 call", "body": "You bought 0.50 shares …", "url": "https://app…/NVDA/…", "kind": "fill_receipt" }
```

## Delivery (for N2-02)

```ts
const { delivery } = await startNotifier(config);            // src/app.ts
await delivery.enqueue(kind, address, payload, dedupeKey(kind, address, seriesId, bucket));
// → { queued, duplicates, filtered }; throws EnqueueError on an invalid payload or key
```

- `kind`: `strike_cross | price_alert | expiry_24h | expiry_1h | settlement_receipt | fill_receipt
  | writer_itm_warning | auto_roll | payout_failed_to_ledger`; payload shapes in `src/events.ts`
  (indexer `Money` and `SeriesRef` objects pass straight through). Every long-position payload
  carries `cost`.
- `dedupeKey` = `kind:address:seriesId:bucket`. Same key again = no new message, per subscription.
- At least once; 3 retries (30 s, 2 min, 10 min, or a longer Retry-After); a circuit breaker per
  channel postpones without spending attempts; messages older than 6 h are dropped; push 404/410,
  Telegram "blocked" / "chat not found" and recipient-level SMTP 550 disable the subscription.
- **Hourly caps are per class** (F4 D7): 60 receipts (`fill_receipt`, `settlement_receipt`,
  `payout_failed_to_ledger`, `auto_roll`) and 20 alerts (everything else) per subscription per
  rolling hour. Each class counts only its own sends, so a wallet holding positions in many markets
  cannot lose its receipts behind a wave of expiry reminders. The excess is dropped, not delayed,
  with `last_error_code` = `rate_limited:receipts` or `rate_limited:alerts`.

## Rules engine (N2-02)

Every `RULES_POLL_S` (30 s) one tick, over the indexer API v2 at `INDEXER_URL`:

1. the watch set: wallets with a verified, enabled subscription, and their price alerts;
2. `GET /v2/markets` (spot and its `spotUpdatedAt`);
   `GET /v2/feed/activity?since=<cursor − 60 s>&kinds=fill,settlement,redemption,roll,stale_cancel`,
   paged (200 × 10 pages per tick, then resumed from the indexer cursor), items already handled skipped;
   a market whose oracle is unavailable has `spot: null` and `spotUpdatedAt: null`, so price
   rules skip that ticker while healthy tickers and activity receipts continue. The `kinds` list is
   explicit (`ACTIVITY_KINDS`) so the indexer can ship a new feed kind first: the notifier's activity
   schema is a strict union, and one unknown kind would fail the whole page. A kind the notifier can
   parse but does not ask for is a message that can never fire, so the two are pinned to each other
   in `engine.test.ts`. The successful read also fills the ticker cache the API checks price alerts
   against, and each ticker's `spotUpdatedAt` goes into the snapshot for the "as of" below;
3. `GET /v2/accounts/:address/positions` for watched wallets only: those an item touched (taker, maker
   and fill recipient are all in `accounts`), those never read, and the stalest of the rest (every
   5 min, 50 per tick). No holders or strategies scan;
4. settlements for the worthless-long receipt come from the feed's settlement items. A redemption
   carries its own `settlementPrice`, so no receipt reads `/v2/series`. `GET /v2/series/:longId` is
   only a fallback, for a held long seen turning settled with no settlement item seen for it (a wallet
   watched after the item went by), read at that transition and not again;
5. `GET /v2/calendar/holidays?fromDay&toDay` for the days after each watched active strategy's expired
   series, in fixed 62-day blocks (the route's cap), cached an hour per block. A failed read is not
   fatal: the auto-roll rule waits for the days, and a stale block is used over none;
6. the rules, then `enqueue`, then cursor + snapshot + holdings persisted in one transaction
   (`notifier.rules_state`, `notifier.rules_holdings`). A crash re-runs the tick; dedupe keys absorb it.

| kind | fires when | to | dedupe bucket |
|---|---|---|---|
| `fill_receipt` | a fill | taker, maker, and the v4 `data.recipient` when it is not the taker: it received the longs of an ask hit (a buy costing the premium, `payer` = taker) or the proceeds of a bid hit (premium − seller fee − taker fee, `seller` = taker); the taker's receipt names it (`recipient`). A taker that is its own recipient gets one receipt | `<activity id>-<role>` (`taker`, `maker`, `recipient`) |
| `strike_cross` | spot reaches strike × 1.0025 from below, or strike × 0.9975 from above | long and short holders | `<position>-<above\|below>-<NY date>` |
| `price_alert` | spot at or beyond a subscriber level after not being there (an alert already true when first seen fires once) | that wallet | `<direction>-<level>-<NY date>` |
| `expiry_24h` / `expiry_1h` | a held series enters (23 h, 24 h] / (45 min, 60 min] before expiry | holders | `<position>` |
| `writer_itm_warning` | a short is in the money from 09:30 New York on its expiry date | writer | `itm` |
| `settlement_receipt` | a redemption; or a held long whose series settled worthless (not redeemed) | holder | `<side>-<activity id>`, worthless long `long-worthless` |
| `payout_failed_to_ledger` | a redemption credited to the ledger for a wallet whose `toLedger` pref is off | holder | `<activity id>` |
| `auto_roll` | a roll; a `stale_cancel` item, i.e. `AutoRoller.cancelStale` withdrew a resting ask the spot had overtaken (v7); or an active strategy whose roll has been due for more than 24 h. Due = 09:30 New York on the first ExpiryCalendar session day after its series' expiry date (a Friday expiry is due Monday, or Tuesday when Monday is a holiday). The warning states when it fell due and the strategy's `lastRolledAt` | writer | `rolled-<activity id>`, `withdrawn-<activity id>`, `skipped` |

**"As of".** `strike_cross`, `price_alert` and `writer_itm_warning` carry the market's own
`spotUpdatedAt`, and their message states it ("NVDA is at 221.40 USDG as of Thu 17 Sep, 11:35am
EDT, …"). The spot is the on-chain one settlement uses, which stops updating from about 17:00 New
York on Friday until Monday's first print, so a payload without that time (an older queued message,
a market that returned none) renders with no time phrase at all — never a substituted clock.

State rules fire on transitions between the previous and the current snapshot, so a condition that
persists is not re-enqueued. **Storm guard:** nothing is sent about an event older than 6 h; after a
restart the feed is read from no earlier than now − 6 h (first boot: now − 6 h). Indexer outages
(5xx, timeout, bad JSON or shape) fail the tick with nothing persisted; the loop logs the code and
backs off 30 s → 5 min. Receipts leave maker rebates out; a long receipt needs the wallet's cost, so a
long the notifier never saw the wallet hold gets no receipt. Holidays come from the indexer's
calendar route: a day it has not answered for is never counted as a session, so the `auto_roll`
skipped warning can come late (when the calendar was unreadable) but never early.

**Cursor.** Since interface v4 the feed is ordered by (block, log index) with every item's `ts` its
block's time; settlements are anchored to the Clearinghouse `SeriesSettled` log, not to the oracle's
earlier finalization, and the indexer serves only blocks 3 behind its head. A later read therefore
cannot list an item older than one already returned, except at the newest second (several blocks
share a timestamp), which the inclusive `since` and the handled ids cover. The re-read window went
from 10 minutes (kept for settlements listed under their earlier finalization time) to 60 s, a
margin for a reorg deeper than the 3-block lag.

The zod shapes in `src/rules/indexer.ts` mirror `web/lib/v2/api-schema.ts` for the fields read, with
the contract's presence and nullability (`recipient`, `settlementPrice`, `lastRolledAt` and the
calendar items are required); unknown keys are tolerated, since the indexer already enforces the
strict schema. `src/rules/fixtures.test.ts` parses the committed `ops/fixtures/api/v2` files with them
and runs the whole service against `ops/fixtures/serve-v2.mjs`.

## Secrets and personal data

Targets are sealed with AES-256-GCM (bound to channel and wallet) before they are written. Logs carry
subscription ids, delivery ids, kinds, channels and error codes; never a target, a wallet address,
a token (link or session), an Authorization header, a signature, a request URL or an error message. Every suite that touches a channel
captures its logs and asserts the test secrets and targets are absent.

## Deploy

One replica only (`railway.json`): the Telegram bot long-polls, and two pollers conflict. Build
context is the repo root.

```bash
# from the repo root
docker build -f notifier/Dockerfile -t callhouse-notifier .
docker run --rm -p 8791:8791 --env-file <your env file> callhouse-notifier
```

Creating the Railway service, the bot, the VAPID keys and the data key are owner actions.
