# web

`app.callhouse.xyz` — the Callhouse dapp. Next.js App Router, React 19, wagmi 3, viem. No custody,
no private keys, no server-side signing.

The marketing landing is a separate package, `site/`, served at `callhouse.xyz`. It carries no
wallet code at all and it is not a copy of anything here; the two domains share a repository and a
palette, nothing else at runtime.

**This package is `noindex`.** That is deliberate: the disclosures should have one canonical
address and it is the other domain. The full reasoning is in the comment above `metadata` in
`app/layout.tsx`. `app/robots.ts` states the same thing as a served `robots.txt`, so the two must
be changed together.

```bash
pnpm --filter @callhouse/web dev     # http://localhost:3000  (site owns 3001)
pnpm --filter @callhouse/web build
node ../scripts/copy-lint.mjs        # compliance gate, also runs in CI
```

## Routes

| Route | Content |
|---|---|
| `/` | one vault card: idle and locked, this week's strike, listed / filled / unfilled / assigned, last week's realized USDG per share |
| `/vault/nvda` | deposit, queue withdraw, complete redeem, claim USDG |
| `/vault/nvda/cycle` | the five-rung Overcall ladder, our pick, the order hash, explorer links, and the raw Seaport payload so a buyer can fill from here |
| `/activity` | every harvest, including the unfilled weeks shown as "unfilled, 0" |
| `/docs` | short spec and the risk list |
| `/legal` | geographic restrictions and the Stock Token legal form |

## Copy rules are a CI gate, not a style preference

`scripts/copy-lint.mjs` fails the build on forbidden marketing copy and on missing disclosures.
These come from README "Frontend copy" and TECHSPEC 7.3, and they exist because the product is a
tokenized security in a restricted perimeter. The same script scans `site/` under the identical
rule set — there is no per-package exemption in either direction.

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
- The headline weekly figure is net USDG harvested over TVL at harvest. **Never annualize it.**
- An unfilled week renders as "unfilled, 0". It is the most likely outcome, not an error state.
- No price chart. No candlesticks on a vault share.
- Must work at 400px wide.

## Design tokens are duplicated into `site/`

`app/globals.css` owns the palette, the radii and the two font stacks, and that token block is
copied verbatim into `site/app/globals.css`. It is duplicated rather than imported because `site/`
has to build and deploy with no dependency on this package: two Railway services, two containers,
one repo. **Change a token in one and change it in the other in the same commit.** Otherwise the
two domains drift and a reader sees the seam on the click through from `callhouse.xyz`.

## Environment

Every address comes from `NEXT_PUBLIC_*` at build time; `./.env.example` is this package's
authoritative list and the root `../.env.example` carries the shared defaults. A misconfigured
`NEXT_PUBLIC_VAULT` points the whole UI at a different contract, so treat the build env as
production configuration and check it against `../ops/addresses.json`.

`NEXT_PUBLIC_SITE_URL` (`https://callhouse.xyz`) and `NEXT_PUBLIC_APP_URL`
(`https://app.callhouse.xyz`) are the two domains, read only by `lib/site.ts`. `APP_URL` is Next's
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
a page can say "not written" rather than "unfilled". The flat top-level keys the normaliser also
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
