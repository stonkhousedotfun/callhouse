# site

`callhouse.xyz` — the public landing. Static marketing pages for a product whose dapp lives on a
different domain. Next.js App Router, React 19, one stylesheet, no framework.

```bash
pnpm --filter @callhouse/site dev     # http://localhost:3001  (web owns 3000)
pnpm --filter @callhouse/site build
node ../scripts/copy-lint.mjs         # compliance gate, also runs in CI
```

Two packages, two domains, two Railway services:

| Domain | Package | What it is |
|---|---|---|
| `callhouse.xyz` | `site/` (this one) | explains the product. No wallet. |
| `app.callhouse.xyz` | `web/` | deposit, cycle tape, claim USDG. |

## What this is not

- **No wallet.** `wagmi`, `viem` and `@tanstack/react-query` are not dependencies and must not
  become dependencies. There is no connect button on this domain.
- **No chain reads.** No RPC URL, no contract call, no indexer fetch, no `fetch()` at all.
- **No live data.** Not "live data we cached" — none. The vault is not deployed, so every live
  figure would render as a zero, and a zero next to the word "realized" reads as a result rather
  than as an absence. Every number here is a fixed policy parameter or an address.
- **Not a second copy of the dapp.** Every call to action is an absolute external link to
  `https://app.callhouse.xyz/...`, built with `appUrl()` from `lib/site.ts`. A relative
  `href="/vault/nvda"` on this domain is a 404, not a route into the app.

If a page here ever needs a number that changes, it belongs on the dapp instead.

## Routes

| Route | Content |
|---|---|
| `/` | what the vault does, the weekly cycle in one screen, the three things that can happen to your week, and the link to the app |
| `/how-it-works` | the cycle in detail: the phase machine, the policy table, the addresses, who may call what |
| `/risks` | the unabridged risk list. No buyer, assignment, partial assignment, issuer freeze, fee switch, admin, unaudited contracts |
| `/legal` | geographic restrictions and the legal form of the Stock Token |

Four routes. Adding a fifth means asking whether it is marketing or product; product goes to
`web/`.

## Copy rules are a CI gate, not a style preference

`scripts/copy-lint.mjs` scans `site/` exactly as it scans `web/`, and it fails the build. The
rules come from README "Frontend copy" and TECHSPEC 7.3, and they exist because the product is a
tokenized security in a restricted perimeter. This domain is the *marketing* surface, which is
the surface those rules were written for, so treat them as tighter here, not looser.

**Never appears anywhere under `site/`:** APY, APR, "10% weekly", "projected yield", "annualized", <!-- copy-lint-allow: this line names the forbidden phrases inside an explicit "never" -->
"backed by Nvidia", "dividend paid by Nvidia", "guaranteed yield", "risk-free". <!-- copy-lint-allow: same enumeration, continued -->

The escape hatch is a `copy-lint-allow` comment on the same line and it is only for a sentence
that is an explicit denial. It is not a way to ship the phrase.

Never turn a weekly figure into a yearly one, by multiplication, compounding, illustration or
"for example". No price chart. No candlesticks.

## The honest framing is the brand

Do not write around any of these. They are the pitch, not the fine print:

- Premium is paid only if a buyer fills the listing.
- A week with no buyer pays zero. On a thin book that is the most likely outcome, and it is
  published as a row like any other — not hidden as an error state.
- Assignment can take the collateral at the strike. The upside above it is gone that week.
- Stock Tokens are debt securities issued by Robinhood Assets (Jersey) Limited. Not shares, no
  vote, and the issuer can freeze transfers.
- Not available to US persons.
- No protocol token, no points, no airdrop at launch.
- The contracts in this repo have not been audited.

No exclamation marks, no marketing adjectives. The register is `web/app/page.tsx`: "Deposit one
tokenised stock, receive vault shares."

## Display rules

- Dark theme only (`color-scheme: dark`). Numbers are monospace and tabular. Every panel is a
  flat bordered box.
- **Must work at 400px wide**, with no horizontal scroll. Addresses and order hashes are single
  unbreakable tokens; let them wrap rather than let one push the page sideways.
- British-ish spellings already in use across the repo: "tokenised", "labelled". Match the file
  you are in.

## Design tokens are duplicated from web, on purpose

`app/globals.css` here is a copy of the token block in `web/app/globals.css` — the same palette,
the same radius, the same two font stacks. It is duplicated rather than imported because this
package must build and deploy with no dependency on `web/`: two Railway services, two containers,
one repo.

**Keep them in sync.** If you change a colour in one, change it in the other in the same commit,
or the two domains drift apart and a user notices the seam when they click through to the app.
Nothing here should invent a palette value that does not exist in `web/app/globals.css`.

## Addresses and constants are duplicated too

`lib/site.ts` carries the market ticker, the chain, the explorer and the address table, copied by
hand from `web/lib/contracts.ts`, `web/lib/chain.ts` and the root `README.md` for the same
reason. This site *displays* those addresses; it never calls them. The root `README.md` and
`ops/addresses.json` remain the source of truth — update this file from them, never the reverse.

## Environment

Two optional variables, `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_URL`; see `.env.example`.
Both are inlined at build time, so the Railway Dockerfile takes them as build `ARG`s — setting
them as runtime variables on the service does nothing. Both default to the production domains, so
a local build with no `.env` produces exactly what production produces.

## Deploy

Railway, Dockerfile build, repo root as build context (pnpm hoists dependencies to the root, so a
`site/`-scoped context cannot install). `next.config.mjs` sets `output: "standalone"` and an
`outputFileTracingRoot` of the repo root — read the comment at the top of that file before
changing either.
