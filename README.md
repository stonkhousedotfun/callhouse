# Callhouse

Pooled covered-call account for Robinhood Chain Stock Tokens.

You deposit one tokenized stock. Each week a keeper writes an Overcall call against it, lists the call for USDG, and pays depositors whatever premium actually fills. There is no protocol token at launch. Yield is USDG or it is nothing.

Vault share ticker (first market): **cNVDA**  
Chain: Robinhood Chain (`4663`)  
Venue: [Overcall](https://overcall.finance) (Valorem Clear + Seaport 1.6)

> Premium is paid only if a buyer fills the listing.
> Assignment can take the tokens at the strike.
> Last week's realized USDG is the only number that matters.

---

## What this is

An ERC-4626-style vault plus a weekly keeper.

1. User deposits NVDA Stock Tokens, receives `cNVDA` shares.
2. When Overcall opens the weekly cycle, the keeper locks idle NVDA in Valorem, writes `n` calls, and lists the option ERC-1155 on Seaport.
3. If a buyer fills: vault receives USDG (net of Overcall's 5% premium fee).
4. After Saturday expiry the keeper reclaims. OTM → NVDA back. ITM and exercised → leftover NVDA + strike USDG.
5. 5% of the premium goes to the fee Safe. The rest, including any strike USDG in full, is claimable pro-rata.
6. Withdrawals while a call is open are queued until reclaim.

That is the whole app.

## What this is not

- Not an options exchange. Overcall already is.
- Not JEPQ. There is no dealer desk. Empty book ⇒ 0% that week.
- Not a dividend product. NVDA's cash yield is ~0. A later vault (PFE / SCHD) can lean on the multiplier more.
- Not a claim on Nvidia equity. Stock Tokens are debt securities issued by Robinhood Assets (Jersey) Limited. No vote. Issuer can freeze transfers.
- Not available to US persons. Same perimeter as Stock Tokens.
- No `$CALL` / points / airdrop at launch.

---

## Domains

Two frontends, two domains, two repositories. `callhouse.xyz` is the public landing: static, no wallet code, no chain reads, indexed. `app.callhouse.xyz` is the dapp, `noindex`, reached by link from the landing. Each is a separate Railway service: the dapp deploys from this repository (runbook: [`ops/deploy.md`](ops/deploy.md)), the landing from `leekzor/callhouse-site` (runbook: that repository's README).

| Domain | Code | What it is |
|---|---|---|
| `callhouse.xyz` | `leekzor/callhouse-site` | explains the product. No wallet, no live numbers. Indexed |
| `app.callhouse.xyz` | `/web` (this repo) | deposit, cycle tape, claim USDG. Noindex, reached by link |

---

## Repositories

Callhouse is three private repositories, split out of one on 2026-09-13:

| Repository | What lives there |
|---|---|
| `leekzor/callhouse` (this one) | the app: `web/`, `keeper/`, `indexer/`, `ops/`, `docs/ARCHITECTURE.md`, `docs/WIRING.md`, the spec, plan and task list. Railway `web` and `keeper` (and later `indexer`) deploy from here |
| `leekzor/callhouse-contracts` | the Foundry project, plus `docs/AUDIT-SCOPE.md`, `docs/ACCOUNTING.md` and `SECURITY.md` (the full threat model and the 2026-09-12 review). Solidity CI runs there |
| `leekzor/callhouse-site` | the marketing landing at `callhouse.xyz`: its own Dockerfile, `railway.json`, lockfile, copy-lint twin, and the Railway + apex DNS notes in its README |

The contracts repository is mounted here as a git submodule at `contracts/`, so every `contracts/...` path in these docs resolves inside a full checkout. Clone with it:

```bash
git clone --recurse-submodules git@github.com:leekzor/callhouse.git
git submodule update --init --recursive     # an existing clone, or an empty contracts/
```

The submodule pins one contracts commit. Once the audit commit is tagged, that pin is the audit commit. A contract change reaches this repo only by bumping the pin and then refreshing the ABIs ([`docs/WIRING.md`](docs/WIRING.md) §5). The landing is not a submodule: nothing here builds, imports or deploys it.

---

## How money moves

```
User NVDA ──► Vault
                │ write(optionId, n)
                ▼
     ValoremOptionsClearinghouse
     0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
                │ ERC-1155 option + claim NFT
                ▼
           Seaport 1.6
     0x0000000000000068F116a894984e2DB1123eB395
                │ fill
                ▼
          USDG to vault (95%)
          USDG to Overcall (5%)
                │ Saturday redeem
                ▼
     idle NVDA + USDG ──► depositors (premium less 5%, strike USDG in full)
                       ──► fee Safe (5% of premium)
```

Settlement never reads a price feed. Chainlink is display + a write-gate only.

Lot size is 1.0000 Stock Token per contract. USDG has 6 decimals. Stock Tokens have 18 decimals and an ERC-8056 `uiMultiplier()` for dividends/splits. Internal accounting uses raw balances. The UI shows multiplier-adjusted “share-equivalent.”

---

## Repo

```
/contracts    git submodule → leekzor/callhouse-contracts. Foundry — Vault, Policy, Valorem + Seaport adapters, Distributor
/keeper       Node 22 — weekly roll state machine
/indexer      Ponder — vault / Valorem / Seaport / registry events
/web          Next.js — the dapp at app.callhouse.xyz: deposit, cycle tape, claim USDG
/ops          runbooks, ABIs, Safe addresses, on-chain recon evidence
/docs         architecture and runtime wiring references
```

The landing at `callhouse.xyz` is not in this tree; it is `leekzor/callhouse-site`.

| Read this | For |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how the four packages fit, trust boundaries, and the eight things that look wrong but are not |
| [`docs/WIRING.md`](docs/WIRING.md) | the runtime map: every service hop, the env var that carries it, and what is proven end to end |
| [`contracts/docs/ACCOUNTING.md`](contracts/docs/ACCOUNTING.md) | the money maths — two ledgers, the accrual index, the redeem queue, fees |
| [`contracts/SECURITY.md`](contracts/SECURITY.md) | threat model, trust assumptions, the 2026-09-12 review |
| [`contracts/docs/AUDIT-SCOPE.md`](contracts/docs/AUDIT-SCOPE.md) | audit scope |
| [`SECURITY.md`](SECURITY.md) | how to report something, and pointers to the above |
| [`contracts/README.md`](contracts/README.md) | building, testing and deploying the vault |
| [`keeper/README.md`](keeper/README.md) | running the keeper, every env var, what each alert means |
| [`indexer/README.md`](indexer/README.md) | the schema, the API, backfilling |
| [`web/README.md`](web/README.md) | routes and the copy rules CI enforces |
| `leekzor/callhouse-site` README | the landing: what it must never grow, why it holds no live numbers, its Railway service and the apex-domain DNS step |
| [`ops/deploy.md`](ops/deploy.md) | the `web` and `keeper` Railway services and every build variable |
| [`ops/recon/`](ops/recon/) | the on-chain recon every integration fact in this repo rests on |
| [`plan.md`](plan.md) · [`tasks.md`](tasks.md) | the build plan and current progress |

### Contracts

| Contract | Job |
|---|---|
| `Vault.sol` | Shares, deposit, queued redeem, phase machine |
| `Policy.sol` | On-chain caps: OTM band, min premium, utilization, fee |
| `AdapterValorem.sol` | `write` / redeem / claim-NFT accounting |
| `AdapterSeaport.sol` | EIP-1271 listings, cancel, order hash |
| `Distributor.sol` | Harvest USDG → fee + `accUsdgPerShare` |
| `lib/SeaportOrderLib.sol` | order validation + Seaport's encoders (linked library) |
| `lib/ValoremLib.sol` | the Valorem write/redeem path (linked library) |

No proxy on v1. Fix means Vault v2 + migrate.

Roles: Admin Safe (2/3), Keeper, Guardian (halt writes / cancel listings only).

### Phases

`Idle → Listed → Exercisable → Settling → Idle`

Keeper may `rollOpen` only in `Idle` when the Overcall registry has a live cycle. Guardian may `rollClose` after expiry if the keeper is dead. Pause blocks writes, never idle withdrawals or `rollClose`.

---

## Addresses (mainnet 4663)

Confirm on explorer before wiring. Registries are per-market.

| Piece | Address |
|---|---|
| Valorem Clear | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| NVDA Stock Token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Overcall fee switch key | `0xdAe7e82A2E7D566C67E87C164B05a1C560190782` |
| Overcall NVDA registry | `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` |
| Chainlink RHNVDA / USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |

All confirmed on chain 4663 by `ops/recon/`. Seaport config: zone `0x0`, conduit key `0x0`, order type `1` (PARTIAL_OPEN).

Valorem engine fee is 15 bps of *notional* and is **off** at Overcall launch. If that switch flips on, this vault refuses to write until Admin explicitly accepts it.

There is one registry per market. Overcall's frontend config also carries a top-level `registry` key: that one is the JUGGERNAUT market, **not** NVDA, and wiring it would collateralise NVDA calls against the wrong token. The vault constructor refuses any registry whose collateral, exercise and clearinghouse do not match.

Do not guess the Seaport order shape. It was copied from a real filled Overcall order and is asserted on chain. Overcall's 5% fee is rounded **per contract**, not on the total; rounding on the total produces an order that signs and then cannot be partially filled.

---

## Policy (launch)

| Param | Value |
|---|---|
| Underlying | NVDA only |
| Min OTM | 3% |
| Max OTM | 12% |
| Min list premium | 0.40% of spot / week |
| Max utilization | 95% of idle NVDA |
| Protocol fee | 5% of premium harvested (filled weeks only; never on strike proceeds) |
| Deposit cap | 20 NVDA at launch |
| Max listings signed per cycle | 3 |

Strike is the nearest Overcall rung inside the OTM band. If no rung qualifies, the vault holds spot and writes nothing.

---

## Local dev

Prereqs: Foundry, Node 22, a 4663 RPC.

```bash
cp .env.example .env
pnpm i                     # installs keeper, indexer, web

# contracts — the submodule (git submodule update --init --recursive if empty)
cd contracts
forge install
forge test                                          # unit + invariant, mocks only
FOUNDRY_PROFILE=fork forge test --fork-url $RH_RPC   # against live 4663

# keeper
pnpm --filter @callhouse/keeper dev

# indexer
pnpm --filter @callhouse/indexer dev

# web — the dapp, app.callhouse.xyz
pnpm --filter @callhouse/web dev
```

The two frontends run side by side: web on port 3000 from this checkout, the landing on 3001 from
a checkout of `leekzor/callhouse-site`. Nothing is shared between them at runtime, so a CTA on the
landing is an absolute link to `app.callhouse.xyz`, not a route.

`SeaportOrderLib` and `ValoremLib` are linked public libraries: without them the vault exceeds
the 24 KB runtime limit. Foundry deploys and links them automatically in tests and scripts.

`.env` needs:

See `.env.example` for the full list. The ones with no sensible default:

```
KEEPER_PK=
VAULT=
SAFE_ADMIN=
SAFE_FEE=
GUARDIAN=
DATABASE_URL=
KEEPER_HMAC_SECRET=
ALERT_WEBHOOK=
```

Chain, protocol and registry addresses are pre-filled from `ops/addresses.json`.

Fork tests that must stay green: idle redeem, write exact lots, Seaport fill credits 95%, OTM reclaim, ITM assignment, queued redeem, halt, `feesEnabled` revert, wrong `optionId` revert.

Testnet 46630 **can** host a dry-run. An earlier pass here said it could not; the adversarial re-check refuted that. Valorem Clear is at `0x0059df7c…acbc`, byte-identical to mainnet; ten Overcall registries exist, NVDA at `0xdFA1cab9…4A56` and on the new build with `isWritingOpen()`; the mock NVDA implements `oraclePaused()`; the mock USDG mints permissionlessly. Cycles there are hand-set by Overcall's operator and lapse between rehearsals, and there is no Chainlink RHNVDA feed on 46630, so a testnet cycle needs a stand-in price feed plus either a fresh operator-set cycle or our own `MockRegistry` deployed there. A mainnet fork with a mock registry is still the only place to compress a week into minutes, and Overcall's production listings API is mainnet-only. Evidence for both passes: `ops/recon/R7-R8-testnet-explorer.md`.

---

## Weekly ops

Bind to `registry.cycle()`, not the wall clock. Overcall’s current window is book close Friday 20:00 UTC, expiry Saturday 20:00 UTC.

| When | Action |
|---|---|
| Cycle flips `Open` | `rollOpen` → sign → POST Overcall listings API |
| Hourly while `Listed` | confirm order visible on overcall.finance **and** `/vault/nvda` |
| After `exerciseTimestamp` | no new lists |
| After `expiryTimestamp` | `rollClose` → harvest → settle queue |
| Any time | Guardian `haltWrites` / cancel listing |

If the Overcall API rejects the order, publish the Seaport payload on `/vault/nvda/cycle` so a buyer can fulfill from this UI. An invisible listing is an unfilled week.

Publish every Friday/Saturday result, including **unfilled, 0**.

---

## Frontend copy

Allowed: last week’s USDG per share, strike, fill / no fill, assigned or not.

Not allowed on the marketing surface: APY, “10% weekly,” projected yield, “backed by Nvidia,” “dividend paid by Nvidia.”

Required disclosures: Stock Token legal form, assignment, empty-book weeks, geographic restrictions.

`scripts/copy-lint.mjs` enforces both lists on **both** frontends — `web/` here, and the landing through its twin copy in `leekzor/callhouse-site` — with no per-package exemption, and it fails CI in each repository. The forbidden list must stay identical in both copies: change it in paired commits to both repos. The landing at `callhouse.xyz` is the surface these rules were written for: it is the page a stranger reads before they have connected anything, so the rules are tighter there, not looser.

---

## Risks (short)

- **No buyer.** Most likely failure mode. Yield is zero that week.
- **Assignment.** Upside capped. Vault can go underweight NVDA. v1 does not auto-rebuy.
- **Partial assignment.** Valorem assigns by bucket, not perfectly pro-rata.
- **Issuer freeze.** RHJ can halt transfers. Write and settlement can brick.
- **Fee switch.** 15 bps of notional can eat a weekly OTM premium.
- **Sequencer / API down** into the Friday window.
- **Admin.** Bounds are on-chain; they can still be set too tight or too loose.

Valorem was audited by Zellic (2022–2023) under the old name `OptionSettlementEngine`. Callhouse’s Vault (`contracts/`) has not. Do not mainnet without an audit of *this* code.

---

## Roadmap

**v1 (this repo)** — NVDA vault, manual-grade keeper, queued redemptions, public cycle tape.

**v1.1** — PFE / SCHD deploys of the same bytecode.

**v2 (not this PR)** — auto-rebuy after assignment, Pare y-leg as deposit asset, protocol token funded only by the protocol fee.

Token rule: four published weeks first. Depositors keep 100% of net premium after the stated fee. The token never is the yield.

---

## License

MIT for original code in this repository.

Valorem Clear, Seaport, Stock Tokens, and USDG are third-party contracts. Overcall’s registry and listings API are third-party. Nothing here is affiliated with Robinhood Markets, Inc., Robinhood Assets (Jersey) Limited, Overcall, or Valorem.

Not financial advice. Not an offer of securities.
