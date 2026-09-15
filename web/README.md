# web

`app.callhouse.finance` — the Callhouse dapp. Next.js App Router, React 19, wagmi 3, viem. No custody,
no private keys, no server-side signing. Unaudited, and it says so on every page.

The marketing landing is a separate repository, `leekzor/callhouse-site`, served at
`callhouse.finance`. It carries no wallet code at all and it is not a copy of anything here; the two
domains share a palette, nothing else at runtime.

**This package is `noindex`.** That is deliberate: the disclosures should have one canonical
address and it is the other domain. The full reasoning is in the comment above `metadata` in
`app/layout.tsx`. `app/robots.ts` states the same thing as a served `robots.txt`, so the two must
be changed together.

```bash
pnpm --filter @callhouse/web dev     # http://localhost:3000  (the landing owns 3001)
pnpm --filter @callhouse/web lint
pnpm --filter @callhouse/web typecheck   # the app, then tests/acceptance under its own tsconfig
pnpm --filter @callhouse/web test        # vitest, node environment, no jsdom
pnpm --filter @callhouse/web copy-lint   # compliance gate, also runs in CI
pnpm --filter @callhouse/web build       # next build; NEXT_PUBLIC_VAULT unset builds the "not configured" pages
```

## What the app is, under write on fill

The vault (contracts/, pinned to the redesign of 2026-09-13) **writes calls only inside a Seaport
fill**. Each week the keeper creates one option type on the Valorem clearinghouse
(`clear.newOptionType`, permissionless), the vault arms it (`rollOpen(optionId)`, which validates
the tuple from the clearinghouse itself: asset, USDG, one-token lot, window, both band bounds) and
writes nothing. The keeper then authorises ONE Seaport 1.6 order (`approveListing`): a
`PARTIAL_RESTRICTED` order (orderType 3) whose offerer AND zone are the vault, zone hash zero,
conduit key zero, one ERC-1155 offer item (the clearinghouse, this week's option id, at most the
vault's capacity), ONE ERC-20 consideration item (USDG to the vault, a whole multiple of the size),
`endTime <= cycleExerciseTs`, Seaport's live counter, a random salt and an **empty signature**: the
vault validates the order on Seaport and has no key. Every fill of that order runs the vault's
`authorizeOrder` hook, which re-checks the floors at the spot OF THE FILL and writes exactly the
filled contracts; `validateOrder` reverts the fill unless no token stayed behind. So
`contractsWritten == sold` by construction, unsold inventory cannot exist, and a fill can be refused
after a rally (`PremiumBelowFloorAtFill`, `StrikeBelowBand`) until the keeper reprices (at most
three listings a cycle).

There is no registry, no third-party book, no fee leg and no EIP-1271. **This app's fill page is the
only venue for the vault's calls.** The names "Overcall" and "registry" appear in this repository
only in notes that say they are history.

## Routes

| Route | Content |
|---|---|
| `/` | one vault card: collateral (idle / sold / assigned), this week's strike, calls sold and capacity, the order hash, last week's realized net premium per share (and its strike proceeds on their own line if assigned); the stranded banner when a claim is stranded |
| `/vault/nvda` | deposit (closed whenever `maxDeposit == 0`, with the reason and the Listed-phase risk on screen), queue or instant withdraw, `settleQueue` while flat, complete redeem, claim USDG, the stranded banner with the queuer's pending claim share and a Retry button |
| `/vault/nvda/cycle` | **the fill page**: this week's option type (from the vault's snapshot and `clear.option(optionId)`), the vault's order on chain (`listingHash`, size, gross, Seaport's status), capacity remaining, the live in-fill floor, and the fill card that checks the keeper's order against the chain, simulates the exact fill, then fills it |
| `/activity` | every week, one row per cycle, from the indexer or rebuilt from the vault's own logs: `CallsWritten` per fill, `RollClose`, `Harvest`, `ClaimStranded`, `StrandedClaimRecovered` |
| `/docs` | short spec and the risk list |
| `/legal` | geographic restrictions and the Stock Token legal form |
| `GET /api/keeper/orders` | server side: the keeper's `/orders`, checked against the chain, as the rows the fill page fills. See "The fill flow" |

## The fill flow

The chain carries the authorised hash, the size, the gross and the option id (`listingHash`,
`listingAmount`, `listingGrossUsdg`, `optionId`), but not the salt, the times or the counter a fill
has to send. Those live with the keeper that built the order, at its `GET /orders`. The browser
never reads the keeper: it calls `/api/keeper/orders` on this app's own origin, and that route
(`app/api/keeper/orders/route.ts`, logic in `lib/keeperOrders.ts`) fetches the one URL in
`KEEPER_ORDERS_URL`, a runtime server variable (on Railway,
`http://keeper.railway.internal:8787/orders`). Nothing from the request reaches that fetch, so the
route cannot be aimed anywhere else. Redirects are not followed, the answer is capped at 64 KiB,
5 s (body included) and 8 orders (more is refused whole, as a 502), the chain reads have their own
6 s deadline, and error messages are the route's own words. **Unset, the route answers 503
`{"configured": false}`, the cycle page says the feed is not wired, and nothing can be bought
through the app.**

**What the keeper serves.** `/orders` answers `{ orders: [...] }`; each entry carries `orderHash`
(bytes32 hex), `chainId` (number), `parameters` (Seaport `OrderParameters` as JSON: `offerer`,
`zone`, `offer[]`, `consideration[]` with decimal-string amounts and numeric item types,
`orderType`, `startTime`, `endTime`, `zoneHash`, `salt`, `conduitKey` and
`totalOriginalConsiderationItems`, with NO `counter`) and `signature` (`"0x"`; a 64/65-byte
placeholder from an older keeper is accepted and dropped). Every other key (`seaport`, `vault`,
`optionId`, `contracts`, `filledContracts`, `remainingContracts`, `unitPrice6`, `grossUsdg6`,
`endTime`, `status`) is ignored: the route rebuilds everything it passes on from the parameters
and the chain.

**The keeper is not trusted.** The route reads the chain's state in one Multicall3 `eth_call` (so
one block): the vault's `phase`, `listingHash`, `listingAmount`, `listingGrossUsdg`, `optionId`,
`conduitKey` and `clear`, `Seaport.getCounter` for each offerer and `Seaport.getOrderStatus` for
each order hash. Then, for each order:

1. an order whose hash is not the vault's `listingHash` is an earlier or superseded listing (a
   counter bump retires one without cancelling it, and the keeper serves a row until its end
   time). It goes under `closed` as `notCurrent` and is not checked further: it can never be
   offered, and it must not read as tampering;
2. for the order that names `listingHash`: restores the counter from `getCounter(offerer)` (the
   vault's `lockBook` and `rollClose` bump it, and Seaport bumps by a quasi-random amount, so it is
   never assumed), hashes the components locally (`lib/seaportOrder.ts`, the EIP-712 derivation)
   and with `Seaport.getOrderHash` in a second batch, and requires the two to agree; the keeper's
   own `orderHash` must equal them;
3. runs `checkListingIsOurs` (`lib/listing.ts`, the same check the fill card runs again in the
   browser): offerer AND zone are the vault, orderType 3, zone hash zero, the vault's conduit key,
   one ERC-1155 offer on the clearinghouse the vault names (`vault.clear()`), ONE USDG leg to the
   vault, `gross % amount == 0`, amounts equal to the vault's recorded count, gross and option id,
   the components hash to the hash, and the end time has not passed;
4. only then reads the lifecycle: cancelled, sold out (Seaport's fraction), vault not Listed, or
   end time passed is `closed` with that state. Otherwise `remaining` and `status` come from
   Seaport's fill fraction.

**What the route answers.** `GET /api/keeper/orders` → `{ configured, orders, rejected, closed,
unchecked, error? }` (`lib/keeperOrders.ts` `KeeperOrdersBody`). `orders` is `ListingRow[]`:
`{ orderHash, chainId, offerer, optionId, quantity, remaining, unitPrice6, totalPrice6, startTime,
endTime, salt, counter, status: "open" | "partial", components (OrderComponents JSON, counter
restored), signature: "0x" }`. `rejected` and `unchecked` are `{ orderHash: Hex | null, reasons:
string[] }[]`; `closed` is `{ orderHash, state: "notCurrent" | "soldOut" | "cancelled" |
"notListed" | "expired" }[]`. Only `rejected` is an alarm (one warning line per computation,
`"msg":"keeper orders rejected"`); `closed` is information; `unchecked` is a chain read that
failed. One computation serves every request while it runs and for 2 s after it settles.

**The fill card** (`components/OrderPayload.tsx`) checks the row against the chain AGAIN, from the
vault's own slot read by `useVaultSnapshot`, then simulates the exact `fulfillAdvancedOrder` it
would send (`eth_call`, 800k gas; a first fill measured 386k on the live chain, a top-up 156k),
from the buyer's address, before the button is live. `lib/fillPreflight.ts` says what the result
means: a vault or library error decoded by name (`lib/revert.ts`, against the merged ABI) blocks
the button with the vault's reason; a Seaport pre-hook error blocks it with Seaport's; USDG paused
or frozen blocks it as the token's refusal; a transfer-step failure, a token's `Error(string)` or
USDG's own `InsufficientAllowance` / `InsufficientFunds` means the hook passed and the buyer's
approval is what is missing, which the button's first step fixes. The fill is
`approve(USDG → Seaport, k × unit price)` then `fulfillAdvancedOrder(order, numerator k,
denominator N, signature "0x", extraData "0x", no criteria resolvers, conduit key zero, recipient
= the buyer)`. The raw order JSON on the card lets any Seaport 1.6 client do the same.

`lib/cycleNotices.ts` decides what the cycle page says: Seaport's status first (a sold-out or
cancelled order is a neutral notice and the feed is not asked), then the feed (unconfigured is a
warning that names `KEEPER_ORDERS_URL`; `rejected` is red; a lifecycle state is information; an
authorised hash the keeper is not serving is the thing to escalate, because an unserved order is an
unfilled week).

`lib/keeperOrders.test.ts` covers the counter restore, a superseded order after a counter bump
(closed, no warning), a hash the keeper names that its parameters do not hash to, wrong offerer or
zone, a non-restricted order type, a conduit key, a clearinghouse other than the vault's, expired,
every non-Listed phase, a redirected or inflated payment leg under the authorised hash, cancelled
and sold-out orders as closed (and a tampered sold-out order still rejected), malformed entries, a
keeper flooding 64 KiB of entries (one small 502, one log line), chain reads that fail (unchecked)
or pass their deadline (502 in the route's words), Seaport and the local hash disagreeing, the
share window measured from settle, the browser client's own wording for a timeout, and, over real
local HTTP, an oversized body (declared and streamed), a keeper that never answers or stalls
mid-body, a redirect, and the route's 503 when unconfigured. `lib/listing.test.ts` is one
tampering per test against `checkListingIsOurs`; `lib/fillPreflight.test.ts` and
`lib/revert.test.ts` pin the verdict for every revert class, with encoded revert data and no node.

## The stranded claim, on the pages

`rollClose` goes to Idle even when Valorem's redeem reverts (USDG paused or frozen, the vault
blocklisted on the Stock Token) and keeps the claim: `isStranded()` is `phase == Idle && claimKey
!= 0`. While it holds, `maxDeposit == 0` and instant redemption is off, `rollOpen` reverts
`StillStranded`, and anyone may `retryStrandedClaim()`. `components/StrandedBanner.tsx` renders on
`isStranded()` on every page: the fraction of the claim still owned by live shares
(`strandedRemainingWad`), the fraction owed to settled epochs, the strand generation, and for a
connected account its pending claim share (`owedStrandWad`, plus its slice of a settled epoch's
`epochStrandWad`), its live shares' slice, and what `previewCompleteRedeem` says is collectable now;
the Retry button sends `retryStrandedClaim`. `components/RedeemQueue.tsx` offers `settleQueue`
whenever the vault is Idle and the account's entry is in the current epoch (the queue is the exit
while stranded), and says when part of a redemption waits on the claim.

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
- **Calls sold equals calls written** (`contractsWritten`). Capacity remaining is
  `Policy.maxContracts(totalAssets) − contractsWritten` (`lib/format.ts`), re-sized at every fill.
- **Every deadline is the option type's**, snapshotted by the vault at `rollOpen`
  (`cycleExerciseTs`, `cycleExpiryTs`), printed in UTC and on the Eastern clock (`fmtEastern`: the
  keeper targets the NYSE close, 16:00 America/New_York, 20:00 UTC in daylight time and 21:00 UTC
  from November; Thursday before a Friday market holiday). Nothing is derived from a calendar.
- No price chart. No candlesticks on a vault share.
- Must work at 400px wide.

## Design: Daylight, shared with the landing

The app uses the same "Daylight" design as `callhouse.finance`: Tailwind CSS v4, light and dark
from `prefers-color-scheme` (no toggle), Schibsted Grotesk / Figtree / Geist Mono through
`next/font` (downloaded at build time, so the Docker build needs to reach Google Fonts).

- **Tokens.** `app/globals.css` from `@import "tailwindcss"` through the `link` utility is copied
  verbatim from `app/globals.css` in `leekzor/callhouse-site`. It is duplicated rather than
  imported because the landing has to build and deploy with no dependency on this package. **Change
  a token in one and change it in the other in paired commits to both repos**, and diff the two
  blocks whenever either changes. App-only base rules go in the marked tail at the bottom of the
  file. The default Tailwind palette is off: every colour is a token.
- **Primitives.** `components/ui` holds the building blocks (import from `@/components/ui`).
  Brand, Container, ExternalLink, Eyebrow, Figure and SectionHead are the site's files unchanged;
  Button, Chip, icons, Notice and Panel are the site's, extended; Card heads, Stat, Rows/Row,
  Field, Table, PageHead, CodeBlock and Unit are the app's own. Pages style with Tailwind classes on
  those primitives; there is no class library.
- **Test hooks.** The primitives stamp `data-slot` attributes (`card`, `card-title`, `card-meta`,
  `stat`, `stat-label`, `stat-value`, `stat-sub`, `row`, `k`, `v`, `notice`; `topbar` on the
  header). The fork acceptance run (W-13) finds elements only by those, ids and ARIA names, never by
  class names, so a restyle cannot move a selector. Keep them when you change markup.
- **Browser chrome** (`viewport.themeColor`) and the favicon (`app/icon.svg`) match the site's.

## Environment

Every address comes from `NEXT_PUBLIC_*` at build time; `./.env.example` is this package's
authoritative list and the root `../.env.example` carries the shared defaults. A misconfigured
`NEXT_PUBLIC_VAULT` points the whole UI at a different contract, so treat the build env as
production configuration and check it against `../ops/addresses.json`.

| Variable | Kind | Meaning |
|---|---|---|
| `NEXT_PUBLIC_VAULT` | build, required | the deployed vault; unset builds the "not configured" pages |
| `KEEPER_ORDERS_URL` | **runtime, server side, required for the fill page** | the keeper's `GET /orders`; read per request by `app/api/keeper/orders`, never `NEXT_PUBLIC_`, never a Docker build ARG. Unset, nothing can be bought through the app |
| `NEXT_PUBLIC_CLEARINGHOUSE` | build, default compiled in | the clearinghouse the vault was constructed with; a deploy on our own Clear (`contracts/script/DeployClear.s.sol`) needs its address here. The app reads `vault.clear()` and follows it for every check; the cycle page reports a build whose value disagrees |
| `NEXT_PUBLIC_ASSET`, `NEXT_PUBLIC_USDG`, `NEXT_PUBLIC_SEAPORT` | build, defaults compiled in | explorer-confirmed third-party addresses; overrides for a fork only |
| `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_RPC_URL_2`, `NEXT_PUBLIC_EXPLORER_URL` | build | the chain; blank is unsafe for these (see the Dockerfile) |
| `NEXT_PUBLIC_API_URL` | build | the indexer; unreachable degrades history to the log fallback |
| `NEXT_PUBLIC_VAULT_FROM_BLOCK` | build | the deploy block, so the log fallback is one query |
| `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_DOCS_URL` | build, defaults compiled in | the domains, read only by `lib/site.ts`; never used to reach a node |

`NEXT_PUBLIC_REGISTRY` and `OVERCALL_API_BASE` are gone with the redesign (no registry, no
third-party book) and a value set for either is ignored. Every `NEXT_PUBLIC_*` is inlined by
`next build`, so changing one needs a rebuild, not a restart — `../ops/deploy.md` §3 is the full
table; every one of them has an `ARG` + `ENV` pair in `web/Dockerfile`, which must be kept in step
with `.env.example`.

## The `/v1/cycles` shape is a tested contract

`lib/api.ts` reads the indexer's nested cycle shape — `option`, `written`, `listing`, `fill`,
`settlement`, `harvest`, with every money figure as `{raw, decimals, formatted}` — and that shape
is pinned by the four files under `../ops/fixtures/api/` (a filled, an unfilled, an assigned and a
stranded week, with real numbers: 12 contracts at 4 USDG is 48 gross, 2.4 fee, 45.6 net, 0.456 per
share over 100 shares; the assigned week is 48 + 950 = 998 gross with the same 2.4 fee).
`lib/api.test.ts` runs `normaliseCycle` over them and asserts the exact base-unit integers and
booleans `/activity` renders; the indexer's own test proves it still emits them. A stranded week
(`status: "stranded"`, `settlement.strand: {gen, recovered, ...}`) is a SETTLED row: its close ran
and its premium was harvested; `strandGen` and `strandRecovered` are carried so the pages can say
"claim stranded" and, later, "recovered". There is no skipped-week row: the vault numbers its own
cycles, so a week the keeper sat out has no row anywhere. The `harvest` group publishes premium
and strike proceeds separately (`premiumGross`, `premiumNet`, `premiumNetPerShare` beside
`strikeProceedsUsdg` and `creditedUsdg`); `normaliseCycle` reads them, and splits a pre-W-21
payload, whose `premiumNet` still included strike proceeds, by subtracting
`settlement.assignmentUsdg`. The `/activity` log fallback (`lib/history.ts`) does the same split
with the `RollClose.usdgFromAssignment` from the closing harvest's own transaction, sums
`CallsWritten` per fill for the week's size, and folds a `StrandedClaimRecovered` retry's
`Harvest` onto the stranded row as fee-free strike proceeds. The flat top-level keys the
normaliser also accepts are a courtesy for a hand-rolled payload, not what the indexer sends. If a
week you know was filled shows as "unfilled, 0" against a live `NEXT_PUBLIC_API_URL`, run
`pnpm --filter @callhouse/web test` first: that is exactly the defect the fixtures exist to catch,
and `../ops/fixtures/api/README.md` says how to regenerate them after a deliberate shape change.

## The ABIs under `lib/abi/` are generated, not hand-written

`lib/abi/vault.ts` is produced by `pnpm gen:abis` (script in `scripts/gen-abis.mjs`) from
`../ops/abis/Vault.json` plus the error fragments of `ValoremLib.json`, `SeaportOrderLib.json` and
`Policy.json`, which are refreshed from the compiled artefacts after any contract change. The
filter keeps the read surface, the functions a depositor may call (`settleQueue` and
`retryStrandedClaim` included) and the two Seaport zone hooks (`authorizeOrder`, `validateOrder`,
so a fill simulation can name what the hook refused with) — never the keeper or admin entry
points — and every event and custom error, including the 36 raised only inside the linked
libraries, so a revert decodes to a name instead of a selector: 92 errors, 36 events, 99
functions. The generator throws if a required function is lost. The other files in that directory
have hand-maintained headers over canonical sources (see their comments; `usdgErrorsAbi` in
`erc20.ts` carries USDG's four reverts with their on-chain selectors); do not edit the bodies by
hand either.

## Fork acceptance (W-13)

`tests/acceptance/fork.acceptance.ts` drives this app in a real browser, from wallets created for
the run, against an anvil fork of 4663 with the keeper running beside it. Write on fill: the
keeper creates the week's option type, arms with `rollOpen(id)`, and the fill page is the venue.
It is typechecked (`pnpm typecheck` runs it under `tests/acceptance/tsconfig.json`). It is not
part of `pnpm test` or CI: it needs anvil, a network fork and a Chromium.

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8548 --code-size-limit 98304   # own terminal
(cd ../contracts && forge build)             # the Vault is 25,765 B; forge's EIP-170 line is noise on this chain
pnpm --filter @callhouse/web acceptance:fork # last line: W-13 FORK ACCEPTANCE PASSED
```

`--code-size-limit 98304` is not optional: chain 4663's real code limit is 98,304 B and without the
flag anvil refuses the vault. The public RPC keeps only a few thousand trailing blocks of state and
rate-limits under load, so start anvil immediately before the run and restart it at the head on a
missing-state error. Optional: `ACCEPTANCE_RPC` (default `http://127.0.0.1:8548`), `ACCEPTANCE_OUT`
(default a temp dir: `run.json` with every tx hash and amount, `keeper.db`, next and browser logs,
and a screenshot plus DOM of each page on failure), `ACCEPTANCE_HEADFUL=1`,
`ACCEPTANCE_KEEPER_LOG_LEVEL`. The Chromium is Playwright's (`playwright-core` 1.63.0, revision
1243); if it is not cached, run `pnpm --filter @callhouse/web exec playwright-core install chromium`
once. **The run overwrites `web/.next` with a build pointed at the fork**; rebuild before serving
anything else from the checkout. It refuses any RPC that is not anvil on chain 4663 and loopback.

**What the run proves.** MockFeed + linked Vault on the real Clear (no registry); wallets funded
by storage writes; the keeper's production modules driven beside the app (`next build` +
`next start` with every `NEXT_PUBLIC_*` on the fork, `NEXT_PUBLIC_API_URL` unreachable so history
comes from the log fallback, and `KEEPER_ORDERS_URL` pointed at the keeper's real `/orders`).
One filled, assigned week under `evm_increaseTime`:

The keeper creates the option type (`newOptionType`), `rollOpen` arms it (nothing written),
`approveListing` authorises a `PARTIAL_RESTRICTED` order with the vault as zone and an empty
signature. **Tamper first:** the keeper's SQLite row is edited so `/orders` serves the payment
leg to an attacker under the authorised hash; `/api/keeper/orders` returns no order and one
rejection, and the cycle page renders no fill card. **Then the row is restored** and a buyer
fills 2 of N from the page's own button (`approve` then `fulfillAdvancedOrder(k, N, "0x")`); a
raw Seaport client fills 3 more from `/orders` with no web code. Each fill emits `CallsWritten`
for exactly those contracts; `contractsWritten == 5`; the vault's option balance is 0. A queued
redemption is escrowed while Listed. The buyer exercises 2 on Clear inside the window;
`lockBook`; `rollClose` → assignment 2, strike proceeds fee-free, `completeRedeem` / `claimUsdg`
to the base unit; "Last week realized" and the `/activity` row agree with the chain (premium and
strike proceeds in separate columns).

Unfilled and stranded weeks are covered by the keeper dry run (`pnpm --filter @callhouse/keeper
dryrun`) and X-11, not by this browser run.

Each wallet is an EIP-1193 provider injected into headless Chromium and announced over EIP-6963;
wagmi's `injected()` connector lists it like an extension, it exposes no account until the page's
Connect flow asks, and it signs the page's `eth_sendTransaction` with a key generated for the run.
It refuses a call it cannot decode against `lib/abi`, so every page transaction is checked by name
and exact arguments. No uncaught page error is tolerated in any state.

**What it does not prove:** a real wallet extension, its approval UI, or a hardware wallet; mobile
browsers or the 400px layout; that the deployed app can reach the deployed keeper over Railway's
private network (a post-deploy check, `ops/deploy.md` §9); the route under a hostile network (its
timeout, byte cap and redirect refusal are `lib/keeperOrders.test.ts`, over local HTTP); the
indexer path (`NEXT_PUBLIC_API_URL` live); the production Docker image; real RPC latency or reorgs.
