# Vendored test vectors

## `lender-epoch-2960.oz.json`

**A COPY. The original is the pin; this is not.**

| | |
|---|---|
| Origin repo | `callhouse-contracts` (private `leekzor`) |
| Origin path | `test/v2/fixtures/lender-epoch-2960.oz.json` |
| Origin branch | `v8` at `7ed7d3523a708ec929e95d8f8f3cf09078f70b02` |
| Landed by | `c8fb46678dd9da992b0ab34c9e9b414050a7bc53` — "P8-05: the lender RewardsDistributor - deploy, verify, rehearse, and the 18-decimal vector" |
| Pinned root | `0x42758658626162126786767f92853840ef916b398e2e936d905f329436abfb44` |

**Why a copy and not a submodule read.** The `contracts/` submodule was not populated in this task's
worktree, and `web/` cannot reach another repository at test time. Reported to the operator rather
than worked around; if the submodule is populated later, read the original and delete this copy.

**What stops the copy drifting silently.** `lenderRewards.test.ts` asserts this file's contents
against the origin repo's **literal** root, written out in the test rather than computed from this
file. A copy that drifts from the artifact the on-chain suite verifies against therefore fails
immediately. Recomputing the root from the copy would make the test agree with itself and detect
nothing — which is the exact failure `T-113` acceptance criterion 4 exists to prevent.

The same root is independently declared at `indexer/scripts/lender-epoch.test.ts:16` in this
repository, so a drift in either direction has two witnesses.
