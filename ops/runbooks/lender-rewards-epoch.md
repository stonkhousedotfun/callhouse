# Lender rewards: generating and posting a weekly epoch

The lender program pays **$STONKHOUSE (18 decimals)** to Earn-vault suppliers, from its **own**
`RewardsDistributor` instance. It is the same contract and the same file format as the maker program, which
pays USDG (6 decimals) from a different instance. Nothing about the two is interchangeable except the code.

## Three facts that decide what you do when something goes wrong

**A posted root is immutable.** `setRoot` refuses an epoch that already has one (`AlreadyFinal`). There is no
edit, no replace, no admin override. Check the root before you post, because afterwards there is nothing to
check.

**A wrong root is corrected by publishing the corrected values under a NEW epoch id.** The bad epoch is
abandoned in place. Do not try to make the old epoch right.

**A defund does NOT cancel unclaimed claims.** `defund` moves the balance to the treasury; it does not touch
any posted root. Every posted-but-unclaimed entry stays claimable for ever, so it stays a liability. A claim
that finds too little money reverts WHOLE and the entry remains claimable — the money is still owed, it simply
cannot be paid yet.

That last fact is why the poster's funding floor is `new epoch total + everything still owed on posted
epochs`, not the new total alone. All epochs pay from one shared balance. Funding only the new epoch means the
first late claimant of an older one takes the new epoch's money, and you find out weeks later when somebody's
claim reverts.

## Generate

    node indexer/scripts/lender-epoch.mjs <epoch> <budget-base-units> --input <balances.json> [--cap-bps 2000] \
      [--exclude 0xHouseVault ...]

`budget` is in **18-decimal base units** — 100 whole tokens is `100000000000000000000`. The credit is
**time-weighted supply**: assets held multiplied by seconds held across the epoch window, not the closing
balance. A wallet that deposits on the last day is credited for one day.

Protocol-owned addresses are dropped, read from `ops/markets/tier1.json` `v2.protocolAddresses`. To exclude a
new protocol wallet, add it to the registry — not to the script.

**THE GENERATOR NOW REFUSES AN EMPTY EXCLUSION LIST, AND BEFORE A DEPLOYMENT THAT MEANS IT REFUSES TO RUN.**
Every value in `v2.protocolAddresses` is `null` until `v2.deployBlock` is set, so on today's committed registry
the exclusion set is empty. It used to run anyway: the guard tested whether the *block* existed, not whether it
held any address, so the protocol's own balances were paid out of the lender budget and the run reported
success with a valid root. If you see `exclusion list is EMPTY`, that is the guard working — fill the registry
block, or pass `--exclude` for each protocol-owned address.

**The House vaults cannot come from the registry.** `v2.protocolAddresses` is a closed schema (`exactKeys`), and
the House vaults are factory-created and per-market, so no fixed key could name them — and adding keys to that
block makes them *required* on every registry the validator walks, which is what left `dev.json` a line short
when `distributors.lender` was added (T-221 → T-247). Pass them with repeated `--exclude` instead. The Earn
vault address is `V2_EARN_VAULT` in the indexer's environment.

**One asset per epoch.** D28 values stock at the settlement oracle spot and credits USD value; this generator
reads no price, so it weighs base units and cannot compare one vault's units to another's. An input mixing two
assets is refused rather than weighted. Stock Earn vaults are out of scope until a priced input exists.

**`--input` is not optional and the reason is one missing route.** The sibling `maker-epoch.mjs` reads
`INDEXER_URL` directly. This program needs per-account Earn-vault *balance history* over the epoch window — a
row per change with `assetsAfter` and a timestamp — and `src/api/v2/earn.ts` serves events per address, not a
balance series per window. Until such a route exists the input file is produced by hand, and this step is not
automatable.

Output defaults to `ops/lender-epochs/<epoch>.json`. Re-running with the same input rewrites nothing: the
generator refuses to overwrite a different file at the same path.

## Post

    RH_RPC=... node indexer/scripts/post-maker-epoch.mjs ops/lender-epochs/<epoch>.json --program lender

Read-only by default. It prints the program, the distributor, the epoch total, what is still owed on earlier
epochs, and the balance required before it will post. Add `--apply --account <keystore>` to send.

`--program lender` resolves the distributor from `v2.protocolAddresses.distributors.lender`. **There is no
fallback for the lender**: if that key is unset the poster refuses rather than guessing, because the only
address it could fall back to is the maker's distributor, which pays a different token.

## Before you post, in order

1. The epoch has ended. The poster refuses while it is still running.
2. `root(epoch)` is zero on the lender distributor. If it is not, stop — see "immutable" above.
3. The distributor holds at least `required`, which the poster prints. This includes older unpaid epochs.
4. The numbers in the output are the ones you expect. The poster will not tell you a budget is wrong.

## What this document does not contain

No rate, no APY, no APR, no projected return. The program pays a **budget** decided per epoch; it does not
promise a yield, and nothing here should be read as one.
