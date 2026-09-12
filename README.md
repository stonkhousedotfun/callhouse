```markdown
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
5. 10% of harvested USDG goes to the fee Safe. The rest is claimable pro-rata.
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
     idle NVDA + USDG ──► depositors (90% of harvest)
                       ──► fee Safe (10% of harvest)
```

Settlement never reads a price feed. Chainlink is display + a write-gate only.

Lot size is 1.0000 Stock Token per contract. USDG has 6 decimals. Stock Tokens have 18 decimals and an ERC-8056 `uiMultiplier()` for dividends/splits. Internal accounting uses raw balances. The UI shows multiplier-adjusted “share-equivalent.”

---

## Repo

```
/contracts    Foundry — Vault, Policy, Valorem + Seaport adapters, Distributor
/keeper       Node 22 — weekly roll state machine
/indexer      Ponder — vault / Valorem / Seaport / registry events
/web          Next.js — deposit, cycle tape, claim USDG
/ops          runbooks, ABIs, Safe addresses
```

### Contracts

| Contract | Job |
|---|---|
| `Vault.sol` | Shares, deposit, queued redeem, phase machine |
| `Policy.sol` | On-chain caps: OTM band, min premium, utilization, fee |
| `AdapterValorem.sol` | `write` / redeem / claim-NFT accounting |
| `AdapterSeaport.sol` | EIP-1271 listings, cancel, order hash |
| `Distributor.sol` | Harvest USDG → fee + `accUsdgPerShare` |

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

Valorem engine fee is 15 bps of *notional* and is **off** at Overcall launch. If that switch flips on, this vault refuses to write until Admin explicitly accepts it.

Overcall NVDA registry and conduit/zone IDs: fill in at deploy from a live Overcall order. Do not guess the Seaport order shape. Copy theirs exactly or their UI will not show the listing.

---

## Policy (launch)

| Param | Value |
|---|---|
| Underlying | NVDA only |
| Min OTM | 3% |
| Max OTM | 12% |
| Min list premium | 0.40% of spot / week |
| Max utilization | 95% of idle NVDA |
| Protocol fee | 10% of USDG harvested (filled weeks only) |
| Deposit cap | 20–50 NVDA at launch |
| Max listings signed per cycle | 3 |

Strike is the nearest Overcall rung inside the OTM band. If no rung qualifies, the vault holds spot and writes nothing.

---

## Local dev

Prereqs: Foundry, Node 22, a 4663 RPC.

```bash
# contracts
cd contracts
forge install
forge test --fork-url $RH_RPC

# keeper
cd ../keeper
cp .env.example .env
pnpm i
pnpm dev

# web
cd ../web
pnpm i
pnpm dev
```

`.env` needs:

```
RH_RPC=
KEEPER_PK=
VAULT=
REGISTRY=
SEAPORT=
CLEARINGHOUSE=
OVERCALL_ORDERS_URL=
SAFE_FEE=
```

Fork tests that must stay green: idle redeem, write exact lots, Seaport fill credits 95%, OTM reclaim, ITM assignment, queued redeem, halt, `feesEnabled` revert, wrong `optionId` revert.

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

---

## Risks (short)

- **No buyer.** Most likely failure mode. Yield is zero that week.
- **Assignment.** Upside capped. Vault can go underweight NVDA. v1 does not auto-rebuy.
- **Partial assignment.** Valorem assigns by bucket, not perfectly pro-rata.
- **Issuer freeze.** RHJ can halt transfers. Write and settlement can brick.
- **Fee switch.** 15 bps of notional can eat a weekly OTM premium.
- **Sequencer / API down** into the Friday window.
- **Admin.** Bounds are on-chain; they can still be set too tight or too loose.

Valorem was audited by Zellic (2022–2023) under the old name `OptionSettlementEngine`. This repo’s Vault has not. Do not mainnet without an audit of *this* code.

---

## Roadmap

**v1 (this repo)** — NVDA vault, manual-grade keeper, queued redemptions, public cycle tape.

**v1.1** — PFE / SCHD deploys of the same bytecode.

**v2 (not this PR)** — auto-rebuy after assignment, Pare y-leg as deposit asset, protocol token funded only by the 10% fee.

Token rule: four published weeks first. Depositors keep 100% of net premium after the stated fee. The token never is the yield.

---

## License

MIT for original code in this repository.

Valorem Clear, Seaport, Stock Tokens, and USDG are third-party contracts. Overcall’s registry and listings API are third-party. Nothing here is affiliated with Robinhood Markets, Inc., Robinhood Assets (Jersey) Limited, Overcall, or Valorem.

Not financial advice. Not an offer of securities.
```

Save that as `README.md` at the repo root. If you want a matching `.env.example` or a shorter `ops/RUNBOOK.md` next, say which.
