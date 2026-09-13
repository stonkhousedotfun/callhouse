# Wiring

The runtime complement to [ARCHITECTURE.md](./ARCHITECTURE.md): which process talks to which,
over which env var, on which port — and what has actually been proven end to end. Where a
statement here disagrees with a package README, the README wins for that package and this file
should be fixed.

Two facts frame everything below:

- **The keeper and the indexer never talk to each other.** Both read the same chain
  independently. The web app reads the chain and the indexer. There is no message bus and no
  shared database.
- **The only hop that moves money is the user's own wallet**, signing against chain 4663
  (deposit, queue, claim, and the Seaport fill on the cycle page). Every other hop is read-only
  JSON or an operator transaction.

---

## 1. The processes

| Process | Package | Default port | Public name | What it is |
|---|---|---|---|---|
| `site` | `leekzor/callhouse-site` (separate repo) | 3001 | `callhouse.finance` | static marketing; **no fetches, no wallet, no chain reads, ever** |
| `web` | `web/` | 3000 | `app.callhouse.finance` | the dapp; Next.js SSR + browser wagmi |
| indexer | `indexer/` | 42069 | not yet chosen (W-19) | Ponder: event indexer + the `/v1/*` read API |
| keeper | `keeper/` | 8787 | none (operator-only) | the roll bot; serves `/health` `/state` `/cycles` `/orders` |
| — | `contracts/` (git submodule → `leekzor/callhouse-contracts`) | — | — | the Vault on chain 4663; not deployed yet |

`site` builds and deploys from its own repository; nothing in this one builds, imports or
deploys it.

## 2. Every hop

### web, browser side

| From → To | What crosses | Env var (build-time inlined) | Default |
|---|---|---|---|
| browser → chain RPC | all live vault/registry/token reads, one Multicall3 batch; tx sends from the wallet | `NEXT_PUBLIC_RPC_URL`, fallback `NEXT_PUBLIC_RPC_URL_2` | `rpc.mainnet.chain.robinhood.com`, `robinhood-rpc.publicnode.com` |
| browser → chain RPC (archive) | `eth_getLogs` history fallback; **primary only** — the backup refuses archive ranges | `NEXT_PUBLIC_RPC_URL` | as above |
| browser → indexer | `GET /v1/cycles?limit=N` for `/`, `/vault/nvda`, `/activity` | `NEXT_PUBLIC_API_URL` | `http://localhost:42069` |
| browser → same-origin proxy | `GET /api/overcall/listings` (the cycle page's order book) | — | — |

The indexer client (`web/lib/api.ts`) is deliberately fail-soft: any error returns `null` and
history pages fall back to `eth_getLogs` against the archive RPC. `fetchVaultSummary`,
`fetchAccount` and `fetchHealth` exist in the client but no page calls them yet — pages read the
vault on-chain. Wallet connection is injected-provider only; there is no WalletConnect.

### web, server side

| From → To | What crosses | Env var (runtime, **not** `NEXT_PUBLIC_`) | Default |
|---|---|---|---|
| proxy route → Overcall | `GET /api/orders?offerer=<vault>&status=all&limit=50`, 9 s timeout, 512 KiB cap; every row shape-checked before it reaches the browser | `OVERCALL_API_BASE` | `https://overcall.finance` |

The proxy is GET-only. Publishing is the keeper's job; the web app never POSTs to Overcall.

### keeper, outbound

| From → To | What crosses | Env var | Default |
|---|---|---|---|
| keeper → chain RPC | every call and send; `eth_getLogs` (harvest sums, boot reconciliation) | `RH_RPC` (**must be archive**) | none — required |
| keeper → chain RPC (backup) | `eth_call` and sends only, **never logs** (it rejects archive reads) | `RH_RPC_2` | publicnode |
| keeper → Overcall | `POST /api/orders?market=NVDA` (publish), GET/DELETE, status polls | `OVERCALL_ORDERS_URL`, `OVERCALL_MARKET` | `https://overcall.finance/api/orders`, `NVDA` |
| keeper → alert relay | JSON POST per alert (13 kinds, `info\|warn\|error`, cooldowns) | `ALERT_WEBHOOK` | unset: logged + stored only |

At boot the keeper reads the vault's own wiring (`asset`, `usdg`, `clear`, `seaport`, `registry`,
fee recipient, conduit key, zone) and **refuses to start if it disagrees with the keeper's env** —
a mispointed keeper exits noisily instead of driving the wrong contract.

### keeper, inbound (its HTTP server, `:KEEPER_PORT`, unauthenticated, read-only)

| Route | Serves | Consumed by |
|---|---|---|
| `/health` | loop-wedged 503; degraded-on-200 for gas/RPC lag | uptime monitor (L-08) |
| `/state` | last snapshot + raw SQLite rows (snake_case) | operator debugging |
| `/cycles` | last 26 cycle rows, snake_case | operator debugging |
| `/orders` | live listings as `{parameters, signature}` fill payloads | **nothing yet** — see §7 |

### indexer, outbound and inbound

| From → To | What crosses | Env var | Default |
|---|---|---|---|
| indexer → chain RPC | backfill + live event sync; Multicall3 overlay on reads | `PONDER_RPC_URL_4663` (archive for backfill) | none — required |
| indexer → Postgres | all indexed state | `DATABASE_URL` + `DATABASE_SCHEMA` (required) | PGlite under `.ponder/pglite` when unset |
| indexer → Overcall | forwarded listing POSTs from the relay | `OVERCALL_ORDERS_URL`, `OVERCALL_MARKET` | same as keeper |
| caller → `POST /v1/overcall/list` | HMAC-SHA256 (`x-callhouse-timestamp`/`x-callhouse-signature`, 300 s skew) | `KEEPER_HMAC_SECRET` (indexer side only) | unset ⇒ relay 503s |
| anyone → `GET /v1/*` | the public read API (`/v1/vault`, `/v1/cycles`, `/v1/account/:addr`, `/v1/listings`, `/v1/snapshots`, `/v1/activity`, `/v1/health`) | — | — |

Ponder reserves `/health`, `/ready`, `/status`, `/metrics` for itself — the indexer's own health
payload is **`/v1/health`**, and that is what an uptime monitor must hit.

## 3. Configuration that must agree

The seven protocol addresses are compiled in as defaults in three places — `keeper/src/config.ts`,
`indexer/lib/env.ts`, `web/lib/contracts.ts` — and the defaults are the same recon-verified
mainnet values in all three (`ops/addresses.json` is the human-readable evidence; **nothing
imports it at runtime**). Override env vars exist per package for forks and rehearsals:

| Address | keeper | indexer | web (build-time) |
|---|---|---|---|
| Vault (ours) | `VAULT` — **required, no default** | `VAULT_ADDRESS` — **required, no default** | `NEXT_PUBLIC_VAULT` — **no default; pages say "not configured" without it** |
| NVDA registry | `REGISTRY` — **required, no default** (wrong-market trap) | `REGISTRY` | `NEXT_PUBLIC_REGISTRY` |
| Valorem Clear | `CLEARINGHOUSE` | `CLEARINGHOUSE` | `NEXT_PUBLIC_CLEARINGHOUSE` |
| Seaport 1.6 | `SEAPORT` | `SEAPORT` | `NEXT_PUBLIC_SEAPORT` |
| USDG | `USDG` | `USDG` | `NEXT_PUBLIC_USDG` |
| NVDA Stock Token | `ASSET` | `ASSET` | `NEXT_PUBLIC_ASSET` |
| Multicall3 | `MULTICALL3` | `MULTICALL3` | compiled into `lib/chain.ts` |
| Overcall fee recipient | `OVERCALL_FEE_RECIPIENT` | `OVERCALL_FEE_RECIPIENT` | `OVERCALL_FEE_RECIPIENT` (constant) |

Every `NEXT_PUBLIC_*` is inlined by `next build`: changing one needs a rebuild, not a restart
(`ops/deploy.md` §3). Keeper and indexer read their env at boot and validate it (zod; the keeper
exits 1 listing every bad value).

## 4. The indexer ↔ web contract is tested at both ends

`GET /v1/cycles` rows are the one shape two codebases share. Four files under
`ops/fixtures/api/` (filled, unfilled, assigned, idle weeks, real numbers) pin it:

- `indexer/src/api/index.test.ts` proves the indexer still emits exactly those bytes
  (`CALLHOUSE_WRITE_FIXTURES=1` regenerates after a deliberate change);
- `web/lib/api.test.ts` runs the web normaliser over the same files and asserts the exact
  base-unit integers and booleans the pages render.

Money travels as `{raw, decimals, formatted}`; consumers read `raw` only. If a filled week ever
shows as "unfilled, 0" against a live API, run both tests before touching anything else.

## 5. ABIs flow one way

`forge build` in `leekzor/callhouse-contracts` → the `contracts/` submodule pin →
`ops/abis/*.json` → generated copies. After any contract change: `forge build` in the contracts
repo, bump the submodule pin here, refresh `ops/abis/` (`Vault.json` takes `.abi` from
`contracts/out/Vault.sol/Vault.json`), then `pnpm gen:abis` in `indexer/` (all four contracts)
and in `web/` (`lib/abi/vault.ts` only — `clear.ts` and `registry.ts` are hand-maintained
derivatives, so check them by eye). The keeper's `keeper/src/abi.ts` is hand-transcribed by
design and must name every custom error the keeper can hit, or a simulation revert prints a bare
selector.

## 6. Same week, two vocabularies — by design

Do not "fix" these; they are different models of the same week:

- Cycle status — indexer: `idle | listed | filled | unfilled | assigned | closed` (public tape);
  keeper: `skipped | open | locked | closed` (its own state machine).
- Listing status — indexer: `approved | partially_filled | filled | cancelled | invalidated |
  expired`; keeper: `approved | posted | visible | post_failed | partial | filled | cancelled |
  expired | unfillable`.
- Premium vs strike proceeds (W-21) — indexer `harvest`: `grossUsdg` is the vault's whole USDG take
  (premium plus strike proceeds); `premiumGross` is premium as harvested,
  AFTER Overcall's 5% and before the protocol fee (`Harvest.grossUsdg − RollClose.usdgFromAssignment`);
  `premiumNet` = `premiumGross − fee`; `strikeProceedsUsdg` is the assigned collateral sold at the
  strike; `creditedUsdg` = `premiumNet + strikeProceedsUsdg` (what holders were credited);
  `premiumNetPerShare` is premium only, `usdgPerShare` is `creditedUsdg` per share and is NOT a return. `fill.premiumGross` is a different number: what buyers paid,
  BEFORE Overcall's cut. Keeper `/cycles`: `gross_usdg6` still includes strike proceeds (the Harvest
  event's own figure); `premium_gross_usdg6` and `strike_proceeds_usdg6` split it. Every figure named
  `premium*` in either service is premium only.
- JSON style — indexer: camelCase, bigints as decimal strings, money as `{raw, decimals,
  formatted}`; keeper `/state` and `/cycles`: raw SQLite rows in snake_case.

## 7. Two paths that exist but carry no traffic today

1. **The web app never calls the keeper.** The cycle page's buy fallback reads Overcall's public
   book through the web proxy, not the keeper's `/orders`. If Overcall's validator rejects the
   vault's listings (open question L-04), Overcall's book will be empty of our rows and the page
   will find nothing — the designed answer is the keeper's own `/orders` (W-13), which the dry
   run proved a real Seaport fill can settle against. Wiring it in means a new env var on `web`
   and a public URL for the keeper, neither of which exists yet.
2. **The indexer's HMAC relay has no caller.** The keeper POSTs to Overcall directly and holds no
   `KEEPER_HMAC_SECRET`. The relay exists so that, if Overcall ever gates its API (auth, IP
   allow-list, rate limits), the credential lives in one managed place instead of on the keeper
   host. Until then `/v1/health` reporting `relay.keeperAuthConfigured: false` is expected.

## 8. What is proven and what is not

| Link | Proven by | State |
|---|---|---|
| indexer serialisation ↔ web parsing | the fixture contract, both test suites | **green** |
| keeper → real Valorem/Seaport/Overcall-shaped book | three-cycle fork dry run, `keeper/DRYRUN.md` | **green** |
| web builds, renders, lints, unit tests | `pnpm --filter @callhouse/web build/test` | **green** |
| keeper boot config cross-check vs the vault | dry run + 66 unit tests | **green** |
| indexer syncing a real week of events | X-11 (fork sync) | **not run** |
| web from a fresh wallet, incl. a fill served from the keeper's `/orders` | W-13 | **not run** |
| Overcall's real validator accepting our EIP-1271 listing | L-04 (one real 1-contract listing) | **not run** |
| keeper → indexer HMAC relay | no caller exists | **unwired** |
| web → keeper `/orders` fallback | no env var, no public keeper URL | **unwired** |
| any production deployment | W-19, W-20, L-08 | **not deployed** |

## 9. Bring the whole thing up against a fork

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
pnpm --filter @callhouse/keeper dryrun        # deploys a vault on the fork, drives 3 weeks

# indexer — copy .env.example to .env.local, then:
PONDER_RPC_URL_4663=http://127.0.0.1:8545 VAULT_ADDRESS=<dry-run vault> START_BLOCK=<fork block> \
END_BLOCK=<head> pnpm --filter @callhouse/indexer dev          # http://localhost:42069

# web — .env.local:
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545 NEXT_PUBLIC_VAULT=<dry-run vault> \
NEXT_PUBLIC_API_URL=http://localhost:42069 pnpm --filter @callhouse/web dev   # http://localhost:3000
```

X-11 and W-13 turn this sketch into the scripted rehearsal; the package READMEs own the details.
