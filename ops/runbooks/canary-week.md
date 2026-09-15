# Canary week

Written 2026-09-14 for the redesigned vault (write on fill, our own Valorem clearinghouse). Supersedes
`projects/callhouse/handoff-2026-09-13/CANARY-RUNBOOK.md`, which describes the pre-redesign Overcall
flow and must not be followed.

The canary is one real week on Robinhood Chain (4663) with the owner's own money, at the smallest size the
contracts allow: one call contract, one fill through the app's own fill page, optionally one exercise.
Everything except about 2 USDG of premium and fees comes back to the owner's wallets.

## Why a canary when the fork runs pass

A fork of 4663 runs the real Seaport, the real Clear bytecode and the real tokens, but it cannot prove:

| Not provable on a fork | Why |
|---|---|
| The live Chainlink RHNVDA/USD feed during a real week | forks warp the clock, so every run swaps in a mock feed seeded with the live answer |
| A real assignment on chain 4663 | Valorem's exercise/assignment path has never run on this chain (integrations/valorem.md) |
| The Railway services, sealed variables, the keeper's volume and restarts | forks run the processes locally |
| The production keys, gas on a busy sequencer, L1 data cost | anvil keys and anvil gas |
| Sourcify verification and Blockscout display of our contracts | not reachable from a fork |
| The public RPC's limits under the keeper's real polling | anvil serves every request |

## Who does what

| Step | Who | When |
|---|---|---|
| A. Buy tokens, fund personal wallets | owner | any time before step D |
| B. Deploy contracts, verify, configure | Claude, with the owner's go-ahead | Mon–Thu, before Fri 10:00 ET |
| C. Railway go-live (web, indexer, keeper stopped) | Claude | right after B |
| D. Deposit 1.06 NVDA from the depositor wallet | owner, in the app | after C, before starting the keeper |
| E. Start the keeper; it creates the week's option type, arms and lists 1 contract | Claude | right after D, during US market hours |
| F. Fill 1 contract from the buyer wallet through the fill page | owner, in the app | after E, before Fri 16:00 ET |
| G. Optional: exercise 1 contract | owner | Fri 16:00 ET to Sat 16:00 ET |
| H. The week closes: lockBook, rollClose | keeper (anyone can) | Fri 16:00 ET, then Sat 16:00 ET |
| I. Redeem and claim USDG | owner, in the app | after H |
| J. Record the week, raise the cap if clean | Claude records; owner decides the cap | after I |

For this week the exercise window is **Fri 2026-09-18 16:00 ET to Sat 2026-09-19 16:00 ET**. If step E
cannot happen by Fri 10:00 ET the keeper picks the following Friday (2026-09-25) automatically: it
arms only when the exercise time is at least `KEEPER_ARM_LEAD_S` (6 h) away.

## A. Buy tokens (owner)

Two personal wallets on Robinhood Chain. They can be the same wallet; two makes the fill look like a
real buyer's. Never use the hot-wallet accounts 0–2 for this.

| Wallet | Needs | Approx. cost at spot 212.73 | Comes back |
|---|---|---|---|
| Depositor | **1.06 NVDA** + ~0.001 ETH gas | ~$226 | yes, redeemed after the week |
| Buyer | **2 USDG** + ~0.001 ETH gas | ~$2 | the premium credits back to the depositor, less the 5% fee |
| Buyer, only to exercise | **+ the week's strike in USDG** (about 223 at today's spot) | ~$223 | yes: the vault pays it back to the depositor as strike proceeds |

Why 1.06: the policy sizes contracts at 95% utilisation and one contract is one whole NVDA, so
`floor(deposit × 0.95)` must be at least 1. The smallest deposit that writes one contract is 1.0527 NVDA.

Where: on chain, no allowlist. The deepest pool is Uniswap NVDA/USDG
(`0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3`, about $7 M liquidity on 2026-09-14). Route: bridge a
little ETH to 4663, swap ETH to USDG, then USDG to NVDA. Distribution of Stock Tokens is restricted for
US persons under the issuer's prospectus; that is the owner's call.

| Token | Address on 4663 | Decimals |
|---|---|---|
| NVDA Stock Token | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 |

Wallet network, if the wallet does not know the chain: chain id `4663`, RPC
`https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`, currency ETH.

## B–C. Deploy and go live (Claude)

Hot wallet, funded 2026-09-14 and re-checked before broadcasting:

| Role | Address | Funded |
|---|---|---|
| Admin, deployer, fee recipient (account 0) | `0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b` | 0.05 ETH |
| Keeper (account 1) | `0x06c131cfEd73A56893f5eB52D17252856FAFC1d2` | 0.02 ETH |
| Guardian (account 2) | `0x29741A8d283a253E8Ce10aDfd04C6507438b6F39` | 0.01 ETH |

Sequence, from `contracts/docs/DEPLOY.md` path A with our own clearinghouse. **Owner decision 2026-09-14: Clear's `feeTo` is a 1-of-1 Safe owned by the owner's personal wallet, not account 0.** `HandoverAdmin` never moves `feeTo`.

1. The contracts branch is merged, tagged `v1.0.0-rc1` and pushed; the app is merged and pushed.
2. Create the 1-of-1 admin Safe on 4663 from account 0, owner = the owner's personal wallet. Record the Safe address.
3. `DeployClear.s.sol` with `CLEAR_FEE_TO` = that Safe. Confirm `feeTo() == Safe` before Deploy. Record the Clear address.
4. `Deploy.s.sol` with `CLEARINGHOUSE` = that address, `ADMIN` = account 0, deposit cap 20 NVDA.
5. `Verify.s.sol` with `EXPECTED_CLEAR_FEE_TO` = the Safe (bootstrap), `Configure.s.sol` (keeper = account 1, guardian = account 2), `Verify.s.sol` again.
6. Sourcify verification for the Clear, both libraries and the vault; import on Blockscout.
7. `ops/addresses.json` filled in; Railway variables set per `ops/deploy.md`, including
   `KEEPER_PREMIUM_MARGIN_BPS=50`, `KEEPER_STRIKE_OTM_BPS=500`, `CLEARINGHOUSE` = our Clear on every
   service, no `ALERT_WEBHOOK` for the canary. Web and indexer deployed; the keeper service created but
   **not started** until step D is done.

Record here after deploy:

| Contract | Address | Block |
|---|---|---|
| Admin Safe (1-of-1, holds Clear `feeTo`) | | |
| Clear (ours) | | |
| SeaportOrderLib | | |
| ValoremLib | | |
| Vault | | |

## D. Deposit (owner)

1. Open `https://app.callhouse.finance/vault/nvda`, connect the depositor wallet.
2. Deposit **1.06 NVDA**: approve, then deposit. The form must show the deposit as open.
3. Tell Claude the transaction hash.

Deposit first so the keeper's first listing already has capacity for one contract.

## E. Keeper arms and lists (Claude)

Start the keeper service during US market hours (Mon–Fri 09:30–16:00 ET) so the feed is fresh. Within
one poll (60 s) it should:

1. compute the Friday close and a strike about 5% above spot, rounded to a whole USDG;
2. call `newOptionType` on our Clear;
3. call `rollOpen(optionId)` (arms only, writes nothing);
4. call `approveListing` for **1 contract** at the floor plus 0.5%.

Check with `GET /health` and `GET /orders` on the keeper, the cycle page, and on chain:
`phase() == 1` (Listed), `listingHash() != 0`, `contractsWritten() == 0`.

## F. Fill one contract (owner)

1. Open `https://app.callhouse.finance/vault/nvda/cycle` with the **buyer** wallet.
2. The page shows the listing, capacity 1, the unit price (about 0.86 USDG at today's spot), and the
   pre-flight result. If it says the fill would be refused after a price move, wait one or two minutes
   for the keeper to reprice and reload.
3. Approve USDG to Seaport, then fill 1. Expect about 460,000 gas for this first fill.
4. Tell Claude the transaction hash.

Claude then checks on chain: one `CallsWritten(…, 1, …)` in the fill transaction,
`contractsWritten() == 1`, the vault's option-token balance is 0, the premium arrived at the vault, and the
buyer holds 1 option token.

## G. Optional exercise (owner)

Only inside the window (Fri 16:00 ET to Sat 16:00 ET). The app has **no exercise button**; exercise
directly on the clearinghouse:

1. From the buyer wallet, approve the Clear to spend the strike in USDG (`approve(clear, strike)` on USDG).
2. Call `exercise(uint256 optionId, uint112 amount)` on our Clear with `amount = 1`. Blockscout's
   "Write contract" tab works once the Clear is verified; Claude can also prepare the calldata for the
   wallet to sign.

Exercising below the strike loses money for the buyer and gains it for the depositor; with both wallets
owned by the owner it nets to zero apart from gas. It proves the first real assignment on this chain.

## H. Close (keeper)

- At Fri 16:00 ET the keeper calls `lockBook()`; deposits and fills close.
- After Sat 16:00 ET the keeper calls `rollClose()`: the claim is redeemed, the premium is harvested with
  the 5% protocol fee on the premium only, and the vault returns to Idle. If the keeper is down, anyone
  can call `lockBook()` from Fri 16:00 ET and `rollClose()` from one hour after expiry (Sat 17:00 ET).
- If the close strands (a USDG pause or freeze), follow `ops/runbooks/incident.md`; `retryStrandedClaim()`
  recovers it and anyone can call it.

## I. Redeem and claim (owner)

1. On `/vault/nvda`, with the vault Idle, redeem all shares instantly. Unassigned, 1.06 NVDA comes back;
   assigned, 0.06 NVDA plus the strike in USDG.
2. Claim USDG: the premium less the fee, plus strike proceeds when assigned.

## J. Done when

- [ ] Deploy verified (Verify.s.sol counts recorded) and sources verified on Blockscout.
- [ ] The keeper created the type, armed and listed without manual help.
- [ ] One fill through the page wrote exactly 1 contract; the vault held 0 option tokens after it.
- [ ] Exercise (if done) assigned exactly 1; `rollClose` settled it.
- [ ] `lockBook` and `rollClose` ran on time from the keeper.
- [ ] Redeem and claim returned the expected amounts to the base unit; Claude reconciles them against the
      indexer API and the chain.
- [ ] No keeper `tx_revert`, `keeper_error` or `claim_stranded` alert.

Then the owner decides the next cap (`setDepositCap`, admin key). The launch plan keeps 20 NVDA until a
second clean week.

## Abort

| Situation | Action | Who |
|---|---|---|
| Anything unexpected before a fill | `haltWrites()` from the guardian (account 2) or the admin; `cancelListing` | Claude |
| A fill refused repeatedly | check `fill_sim_revert` in the keeper log; the keeper reprices up to 3 listings a week | Claude |
| Wrong amount after the close | stop; nothing is redeemed until reconciled | both |
| Keeper down at close | anyone calls `lockBook()` after the exercise time and `rollClose()` from one hour after expiry | anyone |
