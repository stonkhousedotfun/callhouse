# Covered-Call Vault — Technical Specification

Product name (working): $NVDAy vault  
Chain: Robinhood Chain mainnet, chain ID 4663 (testnet 46630)  
Version: 0.1 — launch spec, no protocol token  
Status: buildable against live Overcall / Valorem / Seaport

This is a pooled covered-call account. Users deposit one Stock Token. A keeper writes that week’s Overcall call, lists it for USDG, settles, and pays depositors USDG. Overcall remains the options venue. This app is the account + policy + UI.

0. Non-goals

Do not build an options AMM or order book.
Do not mint a protocol token at launch.
Do not mix tickers in one vault.
Do not promise APY. Show last week’s realized USDG only.
Do not implement Pare dividend-split in v1. The Stock Token already accretes dividends via uiMultiplier(). Treat that as free extra NAV, not a second product.
Do not auto-buy the stock back after assignment in v1. Assignment leaves the vault underweight until deposits refill or a later rebuy() ships.

1. Product rules (immutable product text)

One vault = one Stock Token + USDG.
Depositors own a pro-rata claim on vault assets: idle Stock Token + USDG + Overcall claim NFT + unsold option ERC-1155.
Yield paid out is USDG only (call premium, and USDG received if assigned).
Protocol fee: 5% of the premium harvested that week, only if premium > 0. USDG received from assignment (strike proceeds) is never fee'd. No fee on deposits, no fee on idle stock. (Changed 2026-09-13 from 10% of all harvested USDG; see docs/ACCOUNTING.md §6.)
While a call is open, withdrawals are queued until Saturday reclaim.
If Overcall has no cycle, or Chainlink/oraclePaused() is true on the token, the vault holds spot and writes nothing.
Unfilled listing = that week’s option yield is 0. UI must say so.

Default first market: NVDA. Same code, second deploy: PFE or SCHD.

2. External system map

User ──ERC-20──► Vault (this repo)
                    │
                    │ write / redeem
                    ▼
           ValoremOptionsClearinghouse
           0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
                    │
                    │ ERC-1155 option tokens listed
                    ▼
              Seaport 1.6
           0x0000000000000068F116a894984e2DB1123eB395
                    │
                    │ signed order JSON
                    ▼
           Overcall listings API + OvercallRegistry
                    │
                    ▼
              Buyer pays USDG

Addresses to pin in config, not in bytecode except where immutable:

| Piece | Address / note |
|---|---|
| Valorem Clear | 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 |
| Seaport 1.6 | 0x0000000000000068F116a894984e2DB1123eB395 |
| USDG | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 (6 decimals) |
| NVDA Stock Token | 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC (18 decimals, ERC-8056) |
| Overcall fee key | 0xdAe7e82A2E7D566C67E87C164B05a1C560190782 (can turn Valorem 15 bps fee on; cannot seize collateral) |
| Multicall3 | 0xcA11bde05977b3631167028862bE2a173976CA11 |
| OvercallRegistry | per-market; one registry per collateral token. Read from Overcall docs / explorer at deploy time |

Lot size: 1.0000 Stock Token per contract (1e18). Strike \(S\) dollars ⇒ exerciseAmount = S * 1e6 USDG.

Overcall take: 5% of premium, second Seaport consideration in the same fill. Writer receives 95%. Design NAV math on net USDG received.

Valorem engine fee: 15 bps of notional, currently off. If flipped on, write costs 0.0015 token per contract. Vault must refuse to write when feesEnabled == true until a governance parameter accepts it.

3. Repository layout

/contracts
  src/
    Vault.sol                 // ERC-4626-like, queued redeem
    Policy.sol                // strike/premium bounds library
    AdapterValorem.sol        // write / redeem / claim NFT accounting
    AdapterSeaport.sol        // EIP-712 hash + conduit approvals
    Distributor.sol           // USDG harvest → fee + claimable
    interfaces/
    mocks/
  test/                       // fork 4663
/keeper
  src/
    roll.ts                   // weekly state machine
    policy.ts
    seaport.ts
    overcallApi.ts
    health.ts
/indexer
  src/                        // ponder or subgraph
/web
  app/                        // Next.js
  components/
  lib/wagmi.ts
/ops
  runbooks/
  abis/

Stack: Solidity 0.8.28, Foundry, OpenZeppelin 5, Next.js, wagmi/viem, Ponder (or Envio) indexer, keeper on a small Node box + Safe.

4. Contracts

4.1 Roles

| Role | Who | Powers |
|---|---|---|
| DEFAULT_ADMIN | 2/3 Safe | set keeper, set fee recipient, set policy bounds inside hard caps, pause writes (not withdrawals of idle cash) |
| KEEPER | hot wallet + backup | rollOpen, list, cancelList, rollClose, harvest |
| GUARDIAN | 1/1 hardware key | haltWrites(), cancelAllListings(). Cannot move tokens to self |
| FEE_RECIPIENT | Safe | receives 5% of premium (never strike proceeds) |
| Users | — | deposit, queueRedeem, claim, completeRedeem |

No upgradeability on v1. If you need a fix, deploy Vault v2 and let people migrate. Proxy is optional only after audit.

4.2 Vault.sol — state

IERC20 public immutable asset;          // NVDA
IERC20 public immutable usdg;
IValorem public immutable clear;
ISeaport public immutable seaport;
IOvercallRegistry public immutable registry;

enum Phase { Idle, Listed, Exercisable, Settling }

Phase public phase;
uint32 public cycleNumber;
uint256 public optionId;                // chosen strike this week
uint256 public contractsOpen;           // whole tokens locked in Valorem
uint256 public claimKey;                // Valorem claim NFT id
bytes32 public listingHash;             // current Seaport order hash

uint256 public queuedShares;
uint256 public queuedAssets;            // snapshot at queue time, settled at close

Asset accounting identity (always):

\[
\text{totalAssets} = \text{idle NVDA} + \text{locked NVDA (via claim)} + \text{USDG}_{\text{idle}}/\text{oracle} + \text{unsold option inventory (value 0)}
\]

Do not mark-to-market the short call. Share price only moves when USDG actually arrives or NVDA is assigned away. That keeps the UI honest and avoids an oracle in the money path — same philosophy as Overcall.

Use raw balanceOf for ERC-20 math. Display layer multiplies by uiMultiplier() so users see “share-equivalent.” Never rebase internally.

4.3 ERC-4626 deviations

Standard deposit / mint when phase == Idle or Listed (deposits go to idle balance; they are not added to this week’s short).

withdraw / redeem:

If phase == Idle and contractsOpen == 0: instant.
Else: queueRedeem(shares). Shares locked. After rollClose, pro-rata idle NVDA + USDG paid. If the vault was assigned, redeemers get a mix of leftover NVDA + USDG (the strike proceeds), never a guarantee of 1:1 token back.

Preview functions must return the queue path, not fake instant amounts.

4.4 Policy (on-chain hard caps)

Keeper proposes (optionId, contracts, listPriceUsdg). Vault checks:

```
// REPAIRED 2026-09-12: the original bullet list lost its `<` and `>=` characters to
// markdown/HTML escaping, which merged two checks into one nonsense line.
// Canonical version now lives in plan.md section 4.4.

phase == Idle && !halted
optionId is a member of registry.cycle().optionIds
registry.collateralToken() == asset
registry.exerciseToken()   == usdg
block.timestamp < cycle.exerciseTimestamp
token.oraclePaused() == false
clear.feesEnabled() == false          // or valoremFeeAccepted == true

strike = clear.option(optionId).exerciseAmount
spot   = priceFeed.latestRoundData()  // gate + display only, never in the settlement path

strike >= spot * (10_000 + minOtmBps) / 10_000
strike <= spot * (10_000 + maxOtmBps) / 10_000

listPriceUsdg >= minPremiumBps * spotNotional / 10_000
contracts * 1e18 <= idleAssetBalance * maxUtilizationBps / 10_000
0 < contracts <= maxContractsCap
```

Recommended v1 bounds (governance, inside contract hard caps). Note the minOtmBps row is a FLOOR, not a
ceiling — section 10 requires that admin cannot set it to 0 and sell at-the-money:

| Param | Launch value | Contract ceiling |
|---|---|---|
| minOtmBps | 300 (3%) | floor 100 (admin may NOT go lower; prevents selling ATM) |
| maxOtmBps | 1200 | 2500 |
| minPremiumBps | 40 (0.40% of spot / week) | 10 |
| maxUtilization | 95% of idle | 100% |
| protocolFeeBps | 500 (5% of premium) | 2000 (20% of premium) |
| maxContractsCap | 50 | set per deploy |

If Chainlink is used as a gate only, heartbeat fail ⇒ skip write, stay Idle.

4.5 Phase machine

Idle
  rollOpen()  → write on Valorem → phase = Listed
Listed
  setListing(orderHash)
  cancelListing()            // still Listed or back if inventory returned
  (external) buyer fills Seaport
  after exerciseTimestamp → keeper calls lockBook() → Exercisable
Exercisable
  vault does nothing (buyer may exercise)
  after expiryTimestamp → rollClose()
Settling
  redeem claim on Valorem
  harvest USDG
  settle redeem queue
  → Idle

rollOpen and rollClose are permissioned, idempotent, and must work if the keeper dies mid-week: anyone in GUARDIAN can rollClose after expiryTimestamp + 1 hours.

4.6 Valorem adapter

Vault is the writer address. Flow:

asset.approve(clear, contracts * 1e18)
clear.write(optionId, contracts)  
   Receive: contracts option ERC-1155 + 1 claim NFT (claimKey)
Approve option ERC-1155 to Seaport conduit
After expiry: clear.redeem(claimKey) (name may be redeem / reclaim — bind to the deployed ABI, not this sentence)
Accounting:
   unassigned: NVDA returns to vault
   assigned / partial: leftover NVDA + USDG strike proceeds return
   unsold options still in vault: burn/redeem per Valorem rules so claim can close

Partial assignment is normal. Valorem assigns by bucket, not pro-rata across the whole market. Vault must accept 0..contracts assigned.

Store contractsWritten, contractsSold (1155 leaving vault), contractsRemaining.

4.7 Seaport listing

Copy Overcall’s exact order shape. Do not invent a second shape or Overcall’s UI / API will ignore you.

Requirements:

Offer: ERC-1155 option tokens, amount = contracts to sell
Consideration[0]: USDG to vault = 95% of gross premium
Consideration[1]: USDG to Overcall fee recipient = 5% (match their live fee account from a filled reference order)
endTime = exerciseTimestamp
Zone / conduit: same as Overcall production orders
Partial fills: allow if Overcall allows; otherwise whole-order only

Keeper signs EIP-712 with the vault or the vault contract holds a SeaportOrder that a Safe signed via signTypedData off-chain and the contract only stores orderHash.

Preferred v1: EOA keeper signs as offerer. That requires the option 1155 to sit in the keeper — do not do that.

Correct v1: vault is offerer. Vault has isValidSignature (EIP-1271) and KEEPER calls vault.approveOrder(orderHash) after posting the JSON. Seaport pulls 1155 from the vault.

Post the signed order to Overcall listings API. If you only sign on-chain and never POST, retail buyers on overcall.finance will not see it. That integration is load-bearing.

4.8 Distributor

On harvest():

gross = usdg.balanceOf(vault) - usdgReservedForQueuedRedeems
fee   = (gross - usdgFromAssignment) * protocolFeeBps / 10_000   # premium only; strike proceeds fee-free
net   = gross - fee
usdg.transfer(feeRecipient, fee)
accUsdgPerShare += net * 1e18 / totalShares

Users claimUsdg() at any time. USDG is not auto-compounded into NVDA in v1.

Index this week’s gross, fee, net, fillPrice, assigned for the frontend.

4.9 Pause / halt

haltWrites() blocks rollOpen only.  
Never block queueRedeem, claimUsdg, or rollClose.

Auto-halt conditions (keeper + optional on-chain view):

oraclePaused()
registry cycle missing / optionIds empty
Valorem feesEnabled == true and flag not accepted
listing API down (off-chain; skip list, still allow close)
asset transfer failing (issuer freeze) — surface as emergency, do not write

Stock Tokens can freeze. That can brick write and settlement. Disclose it; you cannot code around the issuer.

5. Keeper

Process: single Node 22 service, one vault per process.

5.1 Schedule (UTC)

| When | Action |
|---|---|
| Sat 21:00 | rollClose if not done |
| Sat 21:30 | settle queue, harvest |
| Sun–Thu 12:00 | health ping; do not write early unless policy says “list as soon as cycle Open” |
| When registry cycle() flips to Open | rollOpen + sign + POST listing |
| Hourly while Listed | poll fill; if fully filled, stop replacing; if cancelled/invalid, relist once |
| Fri 19:50 | last chance relist; after exerciseTimestamp no new list |
| Fri 20:10 | lockBook |

Cycle times from Overcall: book close Friday 20:00 UTC / 16:00 ET, expiry Saturday 20:00 UTC. Bind to registry.cycle(), not the wall clock.

5.2 Strike picker (off-chain, checked on-chain)

spot = chainlink.latestRoundData()          // display + gate only
rungs = registry.cycle().optionIds mapped to strikePerContract
eligible = rungs where strike >= spot * (1 + minOtm) 
                       and strike <= spot * (1 + maxOtm)
pick = eligible[0]  // nearest OTM
premium = max(minPremiumBps * spot / 10_000,
              lastFill * 1.00)
contracts = floor(idle * utilization / 1e18)

If eligible empty → do not write.

5.3 Relist policy

At most 3 signed listings per cycle. Cancel previous via Seaport cancel or increment counter before signing a new price. Never have two live orders covering the same 1155 amount.

5.4 Keys

Keeper hot key: gas + roll* only. Funded with ~0.05 ETH on 4663.
Listing signer: same key via EIP-1271 on vault.
Safe 2/3 for admin.
Guardian 1/1 on a different continent.

If the keeper dies while Listed, options still expire; Guardian rollClose after expiry. Document this on the site.

6. Indexer / backend

Do not put funds or matching here. Backend is read + order POST + alerts.

6.1 Indexer (Ponder)

Listen:

Vault: Deposit, QueueRedeem, Redeem, Harvest, RollOpen, RollClose, Halt
Valorem: write, exercise, redeem filtered by vault address
Seaport: OrderFulfilled for listingHash
Stock Token: Transfer in/out of vault; oraclePaused if event exists
Registry: cycle updates

Write Postgres tables:

vault_snapshots(ts, idle_nvda, locked_nvda, usdg, shares, phase)  
cycles(cycle, optionId, strike, contracts, listed_at, filled_at, premium_usdg, assigned, tx_open, tx_close)  
users(addr, shares, claimable_usdg)

6.2 API

| Method | Path | Purpose |
|---|---|---|
| GET | /v1/vault | TVL, phase, this week |
| GET | /v1/cycles | history |
| GET | /v1/account/:addr | shares, claimable, queue |
| POST | /v1/overcall/list | keeper-only, forwards to Overcall |
| GET | /health | keeper last beat, RPC lag |

Auth: keeper uses HMAC. Public routes cached 15s.

6.3 Overcall API adapter

Reverse the live POST /api/orders from Overcall’s web app (they document it as web/src/app/api/orders). Persist whatever fields they require: chainId, order, signature, optionId, maker. If they reject unknown makers, you need a handshake before launch. Treat that as a launch blocker, not a polish item.

Fallback: public Seaport order on a simple /orders page so a buyer can fulfill from your UI even if Overcall’s front end ignores you.

7. Frontend

Next.js App Router, wagmi, viem, Robinhood Chain added via defineChain.

7.1 Pages

/ — one vault card: ticker, idle + locked, this week strike, “listed / filled / unfilled / assigned”, last week USDG per share  
/vault/nvda — deposit, queue withdraw, claim USDG  
/vault/nvda/cycle — ladder of 5 Overcall strikes, which one we picked, order hash, explorer links  
/activity — every harvest  
/docs — this spec, shortened + risks  
/legal — not available to US persons; Stock Tokens restrictions

7.2 Deposit flow

Connect → switch to 4663 → approve NVDA → deposit.  
Show raw tokens and multiplier-adjusted “share eq.”

7.3 Copy rules

Forbidden on the site:

APY, “10% weekly”, projected yield  
“backed by Nvidia the company”  
“dividend paid in cash by Nvidia”

Required:

“Premium is paid only if a buyer fills the Overcall listing.”  
“Assignment can take your tokens at the strike.”  
“Stock Tokens are debt securities, not equity. No vote.”  
Last week realized: X USDG / share

7.4 Components

PhaseBadge
CycleTape (countdown to book close / expiry from registry timestamps)
PositionSplit bar: idle / listed / assigned
UsdgClaim
TxToast with Blockscout 4663 links

No token chart. No candlesticks on a vault share.

8. Share-price and display math

Let \(s\) be vault shares.

\[
\text{PPS}_{\text{token}} = \frac{\text{idle NVDA} + \text{locked NVDA}}{s}
\]

\[
\text{USDG/share accrued} = \text{accUsdgPerShare}
\]

UI headline this week:

\[
\text{realized weekly} = \frac{\text{net USDG harvested}}{\text{TVL in USD at harvest}}
\]

Do not annualize on the page. Optional footnote: “if this week repeated 52× and always filled, …” — only in docs, not the hero.

Multiplier: display raw * uiMultiplier() / 1e18 as “NVDA-eq.” PPS uses raw.

9. Test plan

9.1 Fork tests (4663)

Deposit, instant redeem in Idle  
rollOpen writes exact contracts  
Simulated Seaport fill → vault USDG += 95%  
Expiry OTM → full NVDA back  
Expiry ITM + exercise → NVDA down, USDG up by strike * assigned  
Partial fill + partial assignment  
Queue during Listed; cannot complete until Settling  
Halt blocks write, not redeem  
feesEnabled == true reverts write  
Wrong optionId reverts  
Relist cancels previous hash  
Multiplier change mid-cycle does not break share math  

9.2 Keeper dry-run

Run 2 weeks against Overcall testnet 46630 if their registry exists there; else mainnet fork + mock registry.

9.3 Invariant

idle + locked + assignedOut == deposits - redemptions for the asset, every close.

10. Security

Audit Vault + adapters. Do not “audit Valorem again”; link Zellic reports Overcall already cites.
Bug bounty after mainnet week 2.
Formal verification not required for v1; invariant tests are.
RPC: two providers. Sequencer outage during Friday window: Overcall already sized exercise to 24h for this reason. Keeper retries; do not write if you cannot list.
No user approvals to the keeper. Only to Vault.

Threats to write down in /docs/risks:

Empty book (economic)  
Issuer freeze (existential)  
Valorem fee switch (margin crush)  
Partial assignment lottery  
Overcall 5% + your 5% of premium stacked (9.75% of gross premium)  
Listing API censorship / downtime  
Admin sets minOtmBps = 0 and sells ATM — cap it

11. Ops runbook (one page)

Open week

Confirm registry.cycleNumber incremented  
Confirm feed live  
Keeper log: strike, contracts, premium  
Verify 1155 balance and Seaport order on explorer  
Confirm order appears on overcall.finance and /vault/nvda/cycle

Close week

After expiry, rollClose  
Screenshot balances  
Harvest; tweet/post only the realized number  
Process redeem queue  
Refill keeper ETH

Incident

Wrong strike listed: Guardian cancel + halt  
Fill at stupid price: live with it; tighten minPremiumBps next cycle  
Assigned more than expected: publish “we are underweight NVDA, deposits buy it back passively”

12. Launch sequence

| Week | Ship |
|---|---|
| 0 | Fork tests green, Safe deployed, docs live, Overcall API handshake done |
| 1 | Vault live, cap 20 NVDA, keeper is you, no fee or fee to Safe |
| 2–4 | Publish four Friday reports. Raise cap |
| 5 | Optional second vault (PFE) — new deploy, same code |
| n | Token only after four filled-or-honestly-unfilled reports. Token gets the protocol fee (5% of premium) buyback. Depositors still get 100% of net premium after that fee |

Deposit cap at launch: 20–50 tokens. Not a TVL race.

13. v2 (explicitly out of v1)

Auto-rebuy NVDA with assignment USDG via Uniswap / 0x RFQ  
Pare y-leg as deposit asset (yNVDA instead of NVDA)  
Protocol token + buyback  
Multi-strike ladder (write 50% 5% OTM, 50% 8% OTM)  
Cross-vault router  
US persons / KYC wrapper — do not build unless counsel says so

14. Acceptance test for “the entire app”

The app is done when a stranger can:

Deposit 1 NVDA  
See this week’s strike and listing hash  
After Saturday, claim USDG (or see “unfilled, 0”)  
Queue and receive leftover NVDA  

No other feature is required for v1.
