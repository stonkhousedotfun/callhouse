# web

`app.callhouse.finance` — the Callhouse dapp. Next.js App Router, React 19, wagmi 3, viem. No custody,
no private keys, no server-side signing.

The marketing landing is a separate repository, `leekzor/callhouse-site`, served at
`callhouse.finance`. It carries no wallet code at all and it is not a copy of anything here; the two
domains share a palette, nothing else at runtime.

**This package is `noindex`.** That is deliberate: the disclosures should have one canonical
address and it is the other domain. The full reasoning is in the comment above `metadata` in
`app/layout.tsx`. `app/robots.ts` states the same thing as a served `robots.txt`, so the two must
be changed together.

```bash
pnpm --filter @callhouse/web dev     # http://localhost:3000  (the landing owns 3001)
pnpm --filter @callhouse/web build
node ../scripts/copy-lint.mjs        # compliance gate, also runs in CI
```

## Routes

| Route | Content |
|---|---|
| `/` | one vault card: idle and locked, this week's strike, listed / filled / unfilled / assigned, last week's realized net premium per share (and its strike proceeds on their own line if assigned) |
| `/vault/nvda` | deposit, queue withdraw, complete redeem, claim USDG |
| `/vault/nvda/cycle` | the five-rung Overcall ladder, our pick, the order hash, explorer links, and the raw Seaport payload so a buyer can fill from here — from Overcall's book, or from the keeper when the book does not show it |
| `/activity` | every harvest, including the unfilled weeks shown as "unfilled, 0" |
| `/docs` | short spec and the risk list |
| `/legal` | geographic restrictions and the Stock Token legal form |
| `GET /api/overcall/listings` | server-side, read-only proxy to Overcall's book for this vault (their API sends no CORS headers) |
| `GET /api/keeper/orders` | server-side keeper fallback: the vault's listing from the keeper's `/orders`, checked against the chain. See "The keeper fallback" |

## The keeper fallback

The vault authorises exactly one Seaport order by hash (EIP-1271). The keeper posts it to
Overcall's book; if Overcall's validator refuses it (open question L-04) or their API is down, the
book never shows it and nobody can buy the week. The keeper keeps serving the order at its own
`GET /orders`. This app reads it there.

**Who calls what.** The browser calls only `/api/keeper/orders` on this app's own origin. That
route (`app/api/keeper/orders/route.ts`, logic in `lib/keeperOrders.ts`) fetches the one URL in
`KEEPER_ORDERS_URL`, a runtime server variable (on Railway,
`http://keeper.railway.internal:8787/orders`). Nothing from the request reaches that fetch, so the
route cannot be aimed anywhere else. Redirects are not followed, the answer is capped at 64 KiB
and 5 s (body included), and error messages are the route's own words. **Unset, the route answers
503 `{"configured": false}` and the cycle page shows nothing about the fallback.**

**The keeper is not trusted.** `/orders` serves `OrderParameters` (no `counter`) plus convenience
fields. The route keeps only the parameters and the signature bytes, and for each order:

1. restores the counter from `Seaport.getCounter(offerer)` (a counter is not always 0: the vault's
   `rollClose` bumps it to kill a week's listings);
2. has Seaport compute the hash with `Seaport.getOrderHash(components)`; the keeper's own
   `orderHash` must equal it, and the row carries Seaport's value, not the keeper's;
3. reads the vault once (`phase`, `listingHash`, `listingAmount`, `listingGrossUsdg`, `optionId`)
   and requires phase Listed, and runs `checkListingIsOurs` (`lib/overcall.ts`, the same check the
   Overcall rows go through): hash equals `listingHash`, offerer and premium recipient are the
   vault, the fee leg is Overcall's 5% to Overcall's recipient rounded per contract, amounts
   match the vault's recorded count, gross and option id, no zone, no conduit, PARTIAL_OPEN, end
   time not passed;
4. reads `Seaport.getOrderStatus`: cancelled or fully sold is rejected; otherwise `remaining` and
   `status` come from Seaport's fill fraction.

Passing orders come back under `orders` in the same row shape `/api/overcall/listings` serves.
Everything else comes back under `rejected` with its reasons and is logged on the server as one JSON
line (`"msg":"keeper order rejected"`); it is never fillable. Answers are shared for 2 s.

**Overcall first.** `/vault/nvda/cycle` asks the route only when Overcall's book has answered (or
failed) and has no live row for the vault's `listingHash` that passes `checkListingIsOurs`. The
keeper's order then renders through the same `OrderPayload` card, labelled "Listed directly by the
vault's keeper; Overcall's book is not showing it.", which runs the same check against the chain
again and fills through the same `approve(Seaport, cost)` + `fulfillAdvancedOrder` with
numerator/denominator. There is no keeper-only fill code. Rejected orders render as a notice with
their reasons and no button; a keeper that does not answer renders as a warning.

`lib/keeperOrders.test.ts` covers the counter restore, a hash that is not `listingHash`, a hash the
keeper names that Seaport does not compute, wrong offerer, expired, every non-Listed phase, a
redirected or inflated payment leg under the authorised hash, cancelled and sold-out orders,
malformed entries, and, over real local HTTP, an oversized body (declared and streamed), a keeper
that never answers or stalls mid-body, a redirect, and the route's 503 when unconfigured. The W-13
fork acceptance below exercises the route against the real keeper server.

## Copy rules are a CI gate, not a style preference

`scripts/copy-lint.mjs` fails the build on forbidden marketing copy and on missing disclosures.
These come from README "Frontend copy" and TECHSPEC 7.3, and they exist because the product is a
tokenized security in a restricted perimeter. The landing repository carries a twin of the same
script with the identical forbidden list — there is no per-package exemption in either direction.
Change that list in paired commits to both repos.

**Never appears anywhere under `web/`:** APY, APR, "10% weekly", "projected yield", "annualized", <!-- copy-lint-allow: this line names the forbidden phrases inside an explicit "never" -->
"backed by Nvidia", "dividend paid by Nvidia", "guaranteed yield", "risk-free". <!-- copy-lint-allow: same enumeration, continued -->

**Must appear verbatim on `/vault/nvda`:**

- "Premium is paid only if a buyer fills"
- "Assignment can take your tokens at the strike"
- "Stock Tokens are debt securities"
- "Last week realized"

**Must appear verbatim on `/legal`:** "not available to US persons",
"Robinhood Assets (Jersey) Limited".

If a forbidden phrase genuinely belongs inside an explicit negation on the docs page, put a
`copy-lint-allow` comment on that line. Use it sparingly, and only where the sentence is a denial.

## Display rules

- Raw balances and the `uiMultiplier`-adjusted "NVDA-eq" figure are both shown, with the adjusted
  one labelled display-only. No internal maths reads the multiplier.
- USDG is 6 decimals, the asset and the shares are 18. Never format one with the other's scale.
- The headline weekly figure is net premium over TVL at harvest. **Never annualize it.**
- **Strike proceeds are not premium.** On an assigned week the harvest also sweeps the USDG the
  assigned collateral was sold for at the strike. It is credited to holders, but it is returned
  principal: every premium figure (gross, net, per share, net / collateral, "Last week
  realized") reads `CycleRow.premium*` and excludes it, and it is shown on its own line as
  "Strike proceeds (assignment)". `creditedUsdg` and `harvestGrossUsdg` on the row include it
  and are never passed to `fmtRealizedWeek` or `usdgPerShare` (W-21).
- An unfilled week renders as "unfilled, 0". It is the most likely outcome, not an error state.
- No price chart. No candlesticks on a vault share.
- Must work at 400px wide.

## Design tokens are duplicated into the landing

`app/globals.css` owns the palette, the radii and the two font stacks, and that token block is
copied verbatim into `app/globals.css` in `leekzor/callhouse-site`. It is duplicated rather than
imported because the landing has to build and deploy with no dependency on this package: two
Railway services, two containers, two repositories. **Change a token in one and change it in the
other in paired commits to both repos.** Otherwise the two domains drift and a reader sees the
seam on the click through from `callhouse.finance`.

## Environment

Every address comes from `NEXT_PUBLIC_*` at build time; `./.env.example` is this package's
authoritative list and the root `../.env.example` carries the shared defaults. A misconfigured
`NEXT_PUBLIC_VAULT` points the whole UI at a different contract, so treat the build env as
production configuration and check it against `../ops/addresses.json`.

Two variables are runtime server-side only, read per request, and change with a restart:
`OVERCALL_API_BASE` (the book proxy's upstream, default `https://overcall.finance`) and
`KEEPER_ORDERS_URL` (the keeper fallback, no default; unset turns the fallback off). Neither may
become `NEXT_PUBLIC_` or a Docker build ARG.

`NEXT_PUBLIC_SITE_URL` (`https://callhouse.finance`) and `NEXT_PUBLIC_APP_URL`
(`https://app.callhouse.finance`) are the two domains, read only by `lib/site.ts`. `APP_URL` is Next's
`metadataBase`; `SITE_URL` is where this app links back to. Neither is ever used to reach a node —
RPCs and addresses live in `lib/chain.ts` and `lib/contracts.ts`. Both have the production values
compiled in as defaults, so a missing variable cannot produce a link to `undefined`; override them
for a preview or for local work, not to fill in a blank. Like every `NEXT_PUBLIC_*` they are
inlined by `next build`, so changing one needs a rebuild, not a restart — `../ops/deploy.md` §3 is
the full table.

## The `/v1/cycles` shape is a tested contract

`lib/api.ts` reads the indexer's nested cycle shape — `written`, `fill`, `settlement`,
`harvest` and the rest, with every money figure as `{raw, decimals, formatted}` — and that shape
is pinned by the four files under `../ops/fixtures/api/` (a filled, an unfilled, an assigned and
a skipped week, with real numbers). `lib/api.test.ts` runs `normaliseCycle` over them and asserts
the exact base-unit integers and booleans `/activity` renders; the indexer's own test proves it
still emits them. The skipped week (`status: "idle"`, `wrote: false`) is the one row nothing on
chain ever closes, so `normaliseCycle` settles it by the registry's expiry and carries `wrote` so
a page can say "not written" rather than "unfilled". The `harvest` group publishes premium and
strike proceeds separately (`premiumGross`, `premiumNet`, `premiumNetPerShare` beside
`strikeProceedsUsdg` and `creditedUsdg`); `normaliseCycle` reads them, and splits a pre-W-21
payload, whose `premiumNet` still included strike proceeds, by subtracting
`settlement.assignmentUsdg`. The `/activity` log fallback (`lib/history.ts`) does the same split
with the `RollClose.usdgFromAssignment` from the closing harvest's own transaction. The flat top-level keys the normaliser also
accepts are a courtesy for a hand-rolled payload, not what the indexer sends. If a week you know
was filled shows as "unfilled, 0" against
a live `NEXT_PUBLIC_API_URL`, run `pnpm --filter @callhouse/web test` first: that is exactly the
defect the fixtures exist to catch, and `../ops/fixtures/api/README.md` says how to regenerate
them after a deliberate shape change.

## The ABIs under `lib/abi/` are generated, not hand-written

`lib/abi/vault.ts` is produced by `pnpm gen:abis` (script in `scripts/gen-abis.mjs`) from
`../ops/abis/Vault.json`, which is itself refreshed from the compiled artefact after any contract
change. The filter keeps the read surface plus the functions a depositor may call — never the
keeper or admin entry points — and every event and custom error, so a revert decodes to a name
instead of a selector. The other files in that directory have hand-maintained headers over
canonical sources (see their comments); do not edit the bodies by hand either.

## Fork acceptance (W-13)

`tests/acceptance/fork.acceptance.ts` drives this app in a real browser, from wallets created for
the run, against an anvil fork of 4663 with the keeper running beside it, and includes a fill of
the keeper's own `/orders` served through this app's `/api/keeper/orders`, after a tampered copy
of the same order has been refused. It is not part of `pnpm test` or CI: it needs anvil, a
network fork and a Chromium.

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8548   # own terminal
(cd ../contracts && forge build)
pnpm --filter @callhouse/web acceptance:fork     # ~1 min; last line: W-13 FORK ACCEPTANCE PASSED
```

Optional: `ACCEPTANCE_RPC` (default `http://127.0.0.1:8548`), `ACCEPTANCE_OUT` (default a temp
dir: `run.json` with every tx hash and amount, `keeper.db`, next and browser logs, and a screenshot
plus DOM of each page on failure), `ACCEPTANCE_HEADFUL=1`, `ACCEPTANCE_KEEPER_LOG_LEVEL`. The
Chromium is Playwright's (`playwright-core` 1.63.0, revision 1243); if it is not cached, run
`pnpm --filter @callhouse/web exec playwright-core install chromium` once. **The run overwrites
`web/.next` with a build pointed at the fork**; rebuild before serving anything else from the
checkout. It refuses any RPC that is not anvil on chain 4663.

**Approach.** A real browser, not calls re-implemented beside the components. The setup deploys a
Vault with MockRegistry and MockFeed and a fresh option series on the real Valorem Clear, the way
`keeper/src/dryrun.ts` does (that file exports nothing and runs itself on import, so its fork
primitives are mirrored, not imported), then imports the keeper's production modules and calls
`reconcile()`/`tick()` and `startHealthServer()`. The app is `next build` + `next start` with every
`NEXT_PUBLIC_*` on the fork (both RPC slots, vault, registry, deploy block) and
`NEXT_PUBLIC_API_URL` unreachable, so history comes from the log fallback; the runtime server
variables are `OVERCALL_API_BASE` (a local stub book) and `KEEPER_ORDERS_URL` (the keeper's real
`/orders`). Each wallet is an
EIP-1193 provider injected into headless Chromium and announced over EIP-6963; wagmi's
`injected()` connector lists it like an extension, it exposes no account until the page's Connect
flow asks, and it signs the page's `eth_sendTransaction` with a key generated for the run. It
refuses a call it cannot decode against `lib/abi`, so every page transaction is checked by name
and exact arguments.

**What it proves**, each figure checked to the base unit on chain and as rendered:

1. **Deposit** (`/vault/nvda`, fresh wallet): Connect, type 25, "Approve and deposit" sends
   `approve(vault, 25e18)` then `deposit(25e18, owner)`; 25 cNVDA minted, "worth 25.0000 NVDA raw".
2. **The fallback fill, through the real route.** Seaport's counter for the vault is set to 7
   before the keeper lists, so nothing downstream can get away with assuming 0. The book the keeper
   posts to refuses the listing (400, the L-04 failure mode): the keeper records `post_failed`,
   alerts `api_reject`, and `/orders` serves the order. The web proxy's upstream answers like that
   book (no row for the vault) for the whole run, and the app runs with
   `KEEPER_ORDERS_URL` pointed at the keeper's real HTTP server. **Tamper first:** the keeper's
   SQLite row is edited so its `/orders` serves the premium leg paid to an attacker under the
   authorised hash; `/api/keeper/orders` returns no order and one rejection naming the keeper's
   wrong hash, the hash mismatch and the redirected premium leg, and `/vault/nvda/cycle` says
   "Overcall's book has no listing matching the vault's current order hash.", shows the keeper
   rejection with those reasons, and renders no fill card and no quantity input. **Then the row is
   restored:** the route serves one order whose `counter` is Seaport's 7, whose components Seaport
   (and `seaportOrderHash` in `lib/keeperOrders.ts`, and the keeper's `localOrderHash`) hash to the
   vault's `listingHash`, which passes `checkListingIsOurs`, and which carries none of the keeper's
   convenience fields. The page renders "Signed order · fill from here" labelled "Listed directly
   by the vault's keeper; Overcall's book is not showing it.", and a second fresh wallet fills 2 of
   23 from its button: `approve(Seaport, cost)` and `fulfillAdvancedOrder` with numerator 2,
   denominator 23, the placeholder signature, no conduit. The vault receives exactly
   writer-per-contract × 2, Overcall fee-per-contract × 2, the buyer holds 2 option tokens. A raw
   Seaport client then fills 3 more straight from the `/orders` JSON, and the `OrderParameters` it
   sends are asserted identical to the ones the page sent.
3. **Queue while Listed**: "Queue redemption" sends `queueRedeem(10e18)`; 10 shares escrowed,
   epoch shown.
4. **Close and collect**: warp, keeper `lockBook` and `rollClose`; one `Harvest` whose gross is
   exactly the two writer legs, fee = floor(gross × 500 / 10000), `QueueSettled` = 10 NVDA plus
   10e18 × index delta / 1e27; "Complete redemption" and "Claim … USDG" deliver exactly those, and
   escrow + claim + fee + dust + owed = gross.
5. **Pages**: "Last week realized" (gross, fee, net, per-share, 0 assigned, no strike-proceeds row)
   and the account's shares, NAV, wallet NVDA and USDG on `/vault/nvda`; the `/activity` row,
   totals, "rebuilt from vault logs" and the indexer notice. No uncaught page error.

**What it does not prove:**

- A real wallet extension (MetaMask, Rabby …), its approval UI, or a hardware wallet; mobile
  browsers or the 400px layout.
- Overcall's hosted book, their validator accepting the vault's EIP-1271 listing (L-04), or their
  front end. Both upstreams here are local stubs.
- That the deployed app can reach the deployed keeper. Here both run on 127.0.0.1; on Railway the
  route goes over private networking to `keeper.railway.internal`, which the keeper's IPv4-only
  bind may not accept (ops/deploy.md §9 item 14). Verify with `curl …/api/keeper/orders` after
  deploying.
- The route under a hostile network: its timeout, byte cap and redirect refusal are covered by
  `lib/keeperOrders.test.ts` over local HTTP, not by this run.
- The indexer path (`NEXT_PUBLIC_API_URL` live, X-11), so "Net / collateral at harvest" renders its
  honest dash; an assigned week on the pages (strike proceeds non-zero); an unfilled week; a
  mid-week deposit checkpoint.
- The real OvercallRegistry and Chainlink feed (mocked so the clock can be warped), the production
  Docker image (`next start` on the build output, not `web/server.js`), and real RPC latency or
  reorgs.
