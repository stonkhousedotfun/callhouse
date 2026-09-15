# Stonkhouse

Renamed from Callhouse (callhouse.finance) to Stonkhouse (stonkhouse.fun) on 2026-09-15. Repo, package, service, env and on-chain names still say callhouse.

Let your stonks work for you. Deposit NVDA into your own account, choose how much is for sale this week, and get paid in USDG if someone buys. Unsold stock comes back. Only your offered stock can be sold.

Chain: Robinhood Chain (`4663`)  
App: `app.stonkhouse.fun/account` (deposit) and `/book` (buy)  
Factory: `0x7850Ae4ac03b651263cE78EC5FcED11b0d0e05A7`

> Premium is paid only if a buyer fills the listing.
> Assignment can take the tokens at the strike.
> Last week's realized USDG is the only number that matters.
> The contracts are unaudited.

---

## What this is

One account per user. No shared vault.

1. User deposits NVDA into their own account.
2. They choose how many NVDA are for sale this week.
3. The keeper lists one order per NVDA on that account.
4. A buyer pays that user. Only that user's stock can be taken.
5. Unsold stock comes back. 5% of the premium is the protocol fee.

That is the whole app.

## What this is not

- Not an options exchange. It sells one call a week on one page.
- Not JEPQ. There is no dealer desk. Nobody buys ⇒ 0% that week.
- Not a dividend product. NVDA's cash yield is ~0.
- Not a claim on Nvidia equity. Stock Tokens are debt securities issued by Robinhood Assets (Jersey) Limited. No vote. Issuer can freeze transfers, blocklist, burn.
- Not available to US persons. Same perimeter as Stock Tokens.
- Not audited. Owner decision 2026-09-13 (D14): the gate is the test suite, described honestly in `contracts/README.md`.
- No `$CALL` / points / airdrop at launch.

---

## Domains

Two frontends, two domains, two repositories. `stonkhouse.fun` is the public landing: static, no wallet code, no chain reads, indexed. `app.stonkhouse.fun` is the dapp, `noindex`, reached by link from the landing. Each is a separate Railway service: the dapp deploys from this repository (runbook: [`ops/deploy.md`](ops/deploy.md)), the landing from `leekzor/callhouse-site` (runbook: that repository's README).

| Domain | Code | What it is |
|---|---|---|
| `stonkhouse.fun` | `leekzor/callhouse-site` | explains the product. No wallet, no live numbers. Indexed |
| `app.stonkhouse.fun` | `/web` (this repo) | deposit, cycle tape, claim USDG, **the fill page**. Noindex, reached by link |

---

## Repositories

Stonkhouse is four private repositories, split out of one on 2026-09-13:

| Repository | What lives there |
|---|---|
| `leekzor/callhouse` (this one) | the app: `web/`, `keeper/`, `indexer/`, `relay/`, `ops/`, `docs/ARCHITECTURE.md`, `docs/WIRING.md`. Railway `web`, `keeper`, `indexer` and `relay` deploy from here |
| `leekzor/callhouse-contracts` | the Foundry project, plus `docs/AUDIT-SCOPE.md`, `docs/ACCOUNTING.md`, `docs/DEPLOY.md` and `SECURITY.md` (the full threat model, the 2026-09-12 review and the 2026-09-13 audit findings with their fixes) |
| `leekzor/callhouse-site` | the marketing landing at `stonkhouse.fun` |
| `leekzor/callhouse-docs` | the GitBook source for `docs.stonkhouse.fun` (pass 2 for the redesign is pending; a push to its `main` publishes immediately) |

The contracts repository is mounted here as a git submodule at `contracts/`, so every `contracts/...` path in these docs resolves inside a full checkout. Clone with it:

```bash
git clone --recurse-submodules git@github.com:leekzor/callhouse.git
git submodule update --init --recursive     # an existing clone, or an empty contracts/
```

The submodule pins one contracts commit: `ca0e985` on branch `redesign/a2-own-strikes-2026-09-13` (the write-on-fill redesign). A contract change reaches this repo only by bumping the pin and then refreshing the ABIs ([`docs/WIRING.md`](docs/WIRING.md) §5). The landing is not a submodule: nothing here builds, imports or deploys it.

---

## How money moves

```
User NVDA ──► Vault  (arms the week: nothing written, nothing held)
                │
   buyer fills on the fill page ──► Seaport 1.6 ──authorizeOrder──► Vault
                │                   0x0000000000000068F116a894984e2DB1123eB395
                │                                                    │ clear.write(id, k)
                │                                                    ▼
                │                                    ValoremOptionsClearinghouse (vault.clear())
                │                                                    │ k option tokens + the claim
                ▼                                                    ▼
      USDG (100% of the premium) to the vault;  k option tokens to the buyer
                │
                │ close after expiry: redeem(claimKey)
                ▼
     idle NVDA + USDG ──► depositors (premium less 5%, strike USDG in full)
                       ──► fee Safe (5% of premium)
```

Settlement never reads a price feed. Chainlink is display plus a gate at arm and at every fill.

There is no venue fee: the whole premium a buyer pays lands in the vault. Lot size is 1.0000 Stock Token per contract. USDG has 6 decimals. Stock Tokens have 18 decimals and an ERC-8056 `uiMultiplier()` for dividends/splits. Internal accounting uses raw balances. The UI shows multiplier-adjusted "share-equivalent."

If the close cannot redeem the claim (USDG paused or frozen, the vault blocklisted on NVDA), the vault does not brick: it reaches Idle with the claim **stranded**, shuts deposits, instant redemption and the next arm, and anyone can `retryStrandedClaim()` until Valorem lets it through. Queuers get their idle slice now and their claim share when it clears.

---

## Repo

```
/contracts    git submodule → leekzor/callhouse-contracts. Foundry — Vault, Policy, Valorem + Seaport adapters, Distributor
/keeper       Node 22 — weekly roll state machine; serves the fill payload at /orders
/indexer      Ponder — vault / Valorem / Seaport / token events, the public cycle tape
/web          Next.js — the dapp at app.stonkhouse.fun: deposit, cycle tape, claim USDG, the fill page
/relay        Node 22 — keeper alert webhook → Discord / Telegram
/ops          runbooks, ABIs, Safe addresses, on-chain recon evidence, go-live script
/docs         architecture, runtime wiring, launch plan
```

The landing at `stonkhouse.fun` is not in this tree; it is `leekzor/callhouse-site`.

| Read this | For |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how the packages fit, trust boundaries, write on fill, and the twelve things that look wrong but are not |
| [`docs/WIRING.md`](docs/WIRING.md) | the runtime map: every service hop, the env var that carries it, and what is proven end to end |
| [`docs/LAUNCH-PLAN.md`](docs/LAUNCH-PLAN.md) | the launch sequence and its live status |
| [`contracts/docs/ACCOUNTING.md`](contracts/docs/ACCOUNTING.md) | the money maths: two ledgers, the accrual index, the redeem queue, the stranded-claim state, fees |
| [`contracts/SECURITY.md`](contracts/SECURITY.md) | threat model, the audit findings AF-01..05 and their fixes, what a compromised keeper or admin can leak through pricing |
| [`contracts/docs/AUDIT-SCOPE.md`](contracts/docs/AUDIT-SCOPE.md) | the review scope, kept for anyone reading the code for bugs |
| [`contracts/docs/DEPLOY.md`](contracts/docs/DEPLOY.md) | deploying the vault: bootstrap admin, optional own clearinghouse, Verify, the Safe handover, the rehearsal record |
| [`SECURITY.md`](SECURITY.md) | how to report something, and pointers to the above |
| [`contracts/README.md`](contracts/README.md) | building and testing the vault; the four things that will bite you |
| [`keeper/README.md`](keeper/README.md) | running the keeper, every env var, what each alert means |
| [`indexer/README.md`](indexer/README.md) | the schema, the API, backfilling |
| [`web/README.md`](web/README.md) | routes, the fill page, and the copy rules CI enforces |
| [`relay/README.md`](relay/README.md) | the alert relay's HTTP contract |
| `leekzor/callhouse-site` README | the landing: what it must never grow, its Railway service and the apex-domain DNS step |
| [`ops/deploy.md`](ops/deploy.md) | the four Railway services, every variable, and the contracts → app hand-off |
| [`ops/recon/`](ops/recon/) | the on-chain recon every integration fact in this repo rests on (some of it, the Overcall parts, is now history) |

### Contracts

| Contract | Job |
|---|---|
| `Vault.sol` | Shares, deposit (one gate), queued redeem, phase machine, the arm, the zone hooks, the stranded-claim state |
| `Policy.sol` | On-chain caps: OTM band, min premium, utilization, fee, listings per cycle |
| `AdapterValorem.sol` | claim accounting, redeem, the mint-only ERC-1155 receiver |
| `AdapterSeaport.sol` | `PARTIAL_RESTRICTED` listings with the vault as zone, cancel, order hash |
| `Distributor.sol` | Harvest USDG → fee + `accUsdgPerShare` |
| `lib/SeaportOrderLib.sol` | order validation + Seaport's encoders (linked library) |
| `lib/ValoremLib.sol` | the arm gate and the fill gate (`writeOnFill`), redeem (linked library) |

No proxy on v1. Fix means Vault v2 + migrate. The Vault runtime is 25,470 B at `ca0e985`: above EIP-170's 24,576 B, under chain 4663's 98,304 B limit, and not portable to an EIP-170 chain.

Roles: Admin (the deployer key at bootstrap, then a 2/3 Safe), Keeper, Guardian (halt / cancel listings only). Seaport 1.6 is the only caller of the zone hooks. Anyone: `lockBook` after exercise, `rollClose` an hour after expiry, `settleQueue`, `retryStrandedClaim`, `sweepFee`, and buying.

### Phases

`Idle → Listed → Exercisable → Settling → Idle`, plus `Idle` **stranded** (the claim kept) until `retryStrandedClaim` succeeds.

Keeper may `rollOpen` only in `Idle`, not stranded, not halted. Anyone may `rollClose` an hour after expiry. A halt blocks arms, listings and fills, never withdrawals, the queue or the close.

---

## Addresses (mainnet 4663)

Confirm on explorer before wiring.

| Piece | Address |
|---|---|
| Valorem Clear (Overcall's unmodified instance; the default clearinghouse) | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| NVDA Stock Token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Clear `feeTo` (the 15 bps fee-switch key on Overcall's instance) | `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` |
| Chainlink RHNVDA / USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |

All confirmed on chain 4663 by `ops/recon/`. Seaport listing shape: orderType `3` (PARTIAL_RESTRICTED), zone = the vault, zoneHash `0x0`, conduit key `0x0`, one USDG consideration item to the vault, empty signature.

The vault may instead be constructed on our own Clear (`contracts/script/DeployClear.s.sol`); `vault.clear()` is the truth and `ops/addresses.json` → `ours.clearinghouse` records it. The Valorem engine fee is 15 bps of *notional* and is **off**. If that switch flips on, the vault refuses to arm and to fill until Admin explicitly accepts it.

There is no Overcall registry in the design any more. The vault reads the option tuple from the clearinghouse itself and numbers its own cycles; the recon under `ops/recon/` about registries and Overcall's API is kept as history.

---

## Policy (launch)

| Param | Value |
|---|---|
| Underlying | NVDA only |
| Min OTM | 3% (both bounds checked at arm; the floor again at every fill) |
| Max OTM | 12% |
| Min list premium | 0.40% of spot / week (re-priced at live spot at every fill) |
| Max utilization | 95% of NAV (compiled ceiling 99.85%) |
| Protocol fee | 5% of premium harvested (filled weeks only; never on strike proceeds) |
| Deposit cap | 20 NVDA at launch |
| Max listings authorised per cycle | 3, cancelled or not |

The keeper chooses a whole-dollar strike inside the band. If none fits, or the floor premium would exceed the strike, the vault holds spot and arms nothing.

---

## Local dev

Prereqs: Foundry, Node 22, a 4663 RPC.

```bash
cp .env.example .env
pnpm i                     # installs keeper, indexer, relay, web

# contracts — the submodule (git submodule update --init --recursive if empty)
cd contracts
forge build --sizes                                 # exits 1 on forge's EIP-170 line; noise on 4663
forge test --no-match-path 'test/fork/*'            # unit + regression + invariant
FOUNDRY_PROFILE=fork forge test --fork-url $RH_RPC   # against live 4663

# keeper
pnpm --filter @callhouse/keeper dev

# indexer
pnpm --filter @callhouse/indexer dev

# web — the dapp, app.stonkhouse.fun
pnpm --filter @callhouse/web dev
```

The two frontends run side by side: web on port 3000 from this checkout, the landing on 3001 from
a checkout of `leekzor/callhouse-site`. Nothing is shared between them at runtime, so a CTA on the
landing is an absolute link to `app.stonkhouse.fun`, not a route.

`SeaportOrderLib` and `ValoremLib` are linked public libraries. Foundry deploys and links them automatically in tests and scripts. **Anvil needs `--code-size-limit 98304`** for the vault.

`.env` needs (see `.env.example` for the full list; the ones with no sensible default):

```
KEEPER_PK=
VAULT=
SAFE_ADMIN=
SAFE_FEE=
GUARDIAN=
DATABASE_URL=
ALERT_WEBHOOK=
```

Chain and protocol addresses are pre-filled from `ops/addresses.json`.

Fork tests that must stay green: a whole week through the live Seaport and Clear (arm, restricted listing, fill through the hook, exercise, close), the real USDG freeze stranding a close, wrong option types refused at arm, out-of-band strikes refused.

Testnet 46630 is not a useful rehearsal target: Overcall's own Clear exists there (`0x0059Df7C…`) but is unusable for us (its cycles are hand-set and lapsed, there is no NVDA Stock Token and no Chainlink RHNVDA feed). A mainnet fork with `--code-size-limit 98304` is the only place to compress a week into minutes. Evidence: `ops/recon/R7-R8-testnet-explorer.md`, `ops/addresses.json` → `46630`.

---

## Weekly ops

Bind to the vault's own state and the option's timestamps (`cycleExerciseTs`, `cycleExpiryTs`), not the wall clock. The keeper anchors the week on the US close, Friday 16:00 ET (20:00 UTC while US daylight saving is in effect, 21:00 UTC otherwise; Thursday's close on a Friday NYSE holiday).

| When | Action |
|---|---|
| Vault Idle, not stranded, regular US session | `clear.newOptionType` → `rollOpen(id)` (arms) → `approveListing` (one restricted order) → serve it on `/vault/nvda/cycle` |
| Every tick while `Listed` | simulate a one-contract fill; on `PremiumBelowFloorAtFill` after a rally, cancel and reprice (≤ 3 authorisations per cycle) |
| After `cycleExerciseTs` | no fills, no new listings; `lockBook` (anyone) |
| After `cycleExpiryTs` | `rollClose` → redeem (if sold) → harvest → settle queue. Stranded? `retryStrandedClaim` on a timer (anyone) |
| Any time | Guardian `haltWrites` / cancel listing; anyone `settleQueue` while flat |

Runbooks: `ops/runbooks/open-week.md`, `close-week.md`, `incident.md`. Alerts: `ops/alerts.md`.

Publish every weekly result, including **unfilled, 0**.

---

## Frontend copy

Allowed: last week's USDG per share, strike, sold / no sale, assigned or not, stranded or not.

Not allowed on the marketing surface: APY, "10% weekly," projected yield, "backed by Nvidia," "dividend paid by Nvidia," "audited."

Required disclosures: Stock Token legal form, assignment, empty-book weeks, deposits during an open week share that week's assignment, geographic restrictions, unaudited.

`scripts/copy-lint.mjs` enforces both lists on **both** frontends (`web/` here, and the landing through its twin copy in `leekzor/callhouse-site`) with no per-package exemption, and it fails CI in each repository. The forbidden list must stay identical in both copies: change it in paired commits to both repos.

---

## Risks (short)

- **No buyer.** Most likely failure mode. Yield is zero that week.
- **Assignment.** Upside capped. Vault can go underweight NVDA. v1 does not auto-rebuy. Bounded to what was sold.
- **Fill refused after a rally.** The floor is re-priced at every fill; a listing can sit unfillable until repriced.
- **Issuer freeze / blocklist / burn.** RHJ can halt transfers, blocklist the vault, burn supply. Deposits and NVDA redemptions fail at the token; a close strands its claim; a burn haircuts the reserve.
- **USDG pause / freeze.** Strands a close, defers the USDG leg of a redemption.
- **Fee switch.** 15 bps of notional can eat a weekly OTM premium; the vault stops until Admin accepts.
- **Sequencer down** into the open window; there is no uptime feed on 4663.
- **Keeper or admin pricing.** A compromised keeper (or the bootstrap admin) can sell at the floor to itself: ≈ 1.1% (2.2%) of sold notional per week at launch policy. The whole bound.
- **Admin.** One deployer key holds every admin power until the Safe handover; no timelock.
- **Unaudited.** Valorem was audited by Zellic (2022–2023) under the old name `OptionSettlementEngine`. Stonkhouse's Vault (`contracts/`) has not been, and the owner has decided to launch without an external audit. The gate is the test suite.

---

## Roadmap

**v1 (this repo)** — NVDA vault, write on fill, self-hosted venue, queued redemptions, public cycle tape.

**v1.1** — PFE / SCHD deploys of the same bytecode.

**v2 (not this PR)** — auto-rebuy after assignment, an admin timelock, vol-model pricing, protocol token funded only by the protocol fee.

Token rule: four published weeks first. Depositors keep 100% of net premium after the stated fee. The token never is the yield.

---

## License

MIT for original code in this repository.

Valorem Clear, Seaport, Stock Tokens, and USDG are third-party contracts. Nothing here is affiliated with Robinhood Markets, Inc., Robinhood Assets (Jersey) Limited, Overcall, or Valorem.

Not financial advice. Not an offer of securities.
