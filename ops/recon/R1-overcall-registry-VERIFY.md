# R1-overcall-registry — adversarial verification pass

**Verdict: CONFIRMED.** Tasked with refuting the R1 report; could not refute any material claim.

Full evidence with raw command output is appended as **"## Verification pass — independent adversarial
re-check"** at the end of `ops/recon/R1-overcall-registry.md`. This file is the summary.

## The answer stands

| Field | Value | How I verified |
|---|---|---|
| OvercallRegistry (NVDA), 4663 | `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` | `eth_getCode` = 5905 bytes, byte-identical on 2 RPCs |
| collateralToken() | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` (NVDA) | `eth_call 0xb2016bd4`, same on 2 RPCs |
| exerciseToken() | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (USDG) | `eth_call 0x2e4d8c8f`, same on 2 RPCs |
| clearinghouse() | `0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0` (Valorem) | `eth_call 0x5d4f5f97` + decoded ctor arg |
| owner() | `0x408adcFFebDF48EC23F1E3811A91AeD3cC951CC0` (EOA, 0 bytes) | `eth_call 0x8da5cb5b`, `eth_getCode`=0 |
| creation tx | `0xadb99c49fca5f5d3c7a8dd6b8f2a6edaff1d9204aaf9ce1d38b959822dfba9e9` | `eth_getTransactionReceipt`, status 0x1 |
| deploy block | 59378796 @ 1789040842 = 2026-09-10 11:47:22 UTC | receipt + `eth_getBlockByNumber` |
| verified | fully verified, `proxy_type: None`, 0.8.28+commit.7893614a, cancun, 200 runs | fresh firecrawl pull of Blockscout |
| Testnet 46630 NVDA | `0xdFA1cab9cdFeA9fBC1fEbcE536EAE90648264A56` | 5905 bytes + reads on **both** testnet RPCs |

## What I attacked, and what happened

- **28 claimed function selectors** — recomputed with `cast sig`, all 28 found in deployed runtime bytecode. No fabrications.
- **20 claimed custom errors** — proved by *triggering live reverts* via `eth_call` with `from`. 10 confirmed
  directly (args and all); remainder are constructor-path and present in the verified ABI.
- **The ABI file** — re-scraped Blockscout myself, diffed against `ops/abis/OvercallRegistry.json`:
  53 vs 53, **IDENTICAL**. Committed ABI is trustworthy.
- **The `cycle()` spec repair** — confirmed. `"status"` appears nowhere in the ABI; no enum/uint8 anywhere.
  Struct is `(uint32 number, uint40 exerciseTimestamp, uint40 expiryTimestamp, uint96 lotSize, uint256[] optionIds)`.
- **Frontend provenance** — re-derived from scratch: chunk `13i994ge4sv4e.js` exists and holds the address book.
  The **JUGGERNAUT trap is real** (top-level `registry:` on 4663 = JUGGERNAUT, not NVDA).

## Corrections / additions

1. **C1** 4 registries were in the prose ("11 mainnet") but missing from the address list. I verified them:
   AI `0xD1d56916f6E945F59C6E226A7429Da688532a113`, CASHCAT `0x1E0F8a0ad60788a5563b8C1fc67c0C5Ad2527Bf1`,
   PONS `0x365B4D099768F6B2fF07200e7d5AA14D899c1897`, SPCX `0x915148f98C0450251261654ffb6B54BA7005efFF`.
2. **C2** "A live cycle can be replaced" is *strengthened*: **8 registries right now have a live cycle AND
   `canReplaceCycle()==1`**. The race is real; `rollOpen` must re-check `isApproved` + `cycleNumber` atomically.
3. **C3** "Someone has written against cycle 1" is true but it is **exactly one rung** — rung 4 (strike 246),
   `nextClaimKey == 2`, one Claim NFT. Rungs 0–3 untouched. CASHCAT is in the same state, so NVDA is not unique.
4. **C4** I suspected `renounceOwnership() view` was a hand-edited ABI defect. It is **not** — the verified ABI
   really says `view`. Refinement: the override keeps `onlyOwner` (non-owner hits `OwnableUnauthorizedAccount`).
5. **C5** `isApproved` = `_cycleOf[id] == cycleNumber && cycleNumber != 0` — self-invalidates on rollover, no
   stale-approval bug. `strikePerContract()` is an unchecked passthrough and must not be used as an eligibility test.
6. **C6** New: testnet owner `0xf73B2cB96aE0bBe1A3Ec3446f4C36D82CAaAAB82` ≠ mainnet owner. Keeper allowlists must be per-chain.

## Two of their UNRESOLVED items are now resolved

- **No canonical published address page exists.** `docs.robinhood.com/chain/docs/contract-addresses/` HTTP-200s
  but is a **soft 404** (body: "Page Not Found"); the Vocs SPA 200s every path — do not trust status codes there.
  Overcall *does* have docs at `overcall.finance/docs`, which publish only `clearinghouse 0x9a7b40e5…` and
  `seaport 0x00000000…eB395` — both corroborating on-chain. No registry address book anywhere. Nothing to diff.
- **NVDA feed verified (R5 input).** `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` is real: 9571 bytes,
  `description() = "RHNVDA / USD"`, `decimals() = 8`, answer `21829793457` → **spot 218.2979**.
  Two consequences:
  - `updatedAt` is **22.5 hours stale** (equity feed, weekend). A short-heartbeat freshness gate would brick the vault.
  - Ladder OTM: 226 → +3.53%, 231 → +5.82%, 236 → +8.11%, 241 → +10.40%, **246 → +12.69%**.
    **Rung 4 falls outside plan §9's 3–12% band — and it is the only rung with open interest.**
    The "no eligible rung" path is reachable in week 1 and must be handled.

## UNRESOLVED (I agree these remain open)

- No public Overcall GitHub repo; Blockscout-verified source is the only upstream. Re-pull and diff at deploy.
- 9 non-NVDA **testnet** registries are frontend-config only; I did not eth_call them.
- Whether Overcall rolls cycle 2 on schedule is unobserved (`cycleCount() == 1`). Watch `CycleSet` through 2026-09-19/20.
- Open interest **notional** per rung not sized (I established *which* rung, not how much). R2/R4.
- All time-dependent values go stale after 2026-09-19 20:00 UTC. Addresses and ABI are immutable.

## Operational warning

The session scratchpad is **shared across parallel recon agents**. A sibling overwrote my `scratchpad/rpc.py`
mid-run with a different module of the same name. It surfaced as a `NameError`, but it could have produced
silently wrong numbers. Everything here was re-run in a private subdirectory afterwards.
**Agents must write helper scripts to a per-agent subdirectory, not the scratchpad root.**
