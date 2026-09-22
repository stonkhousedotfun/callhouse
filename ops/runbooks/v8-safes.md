# Runbook — the two v8 Safes: creating them, and signing without the Safe web app

INTERFACE_VERSION 8 runs two multisigs, not one:

| Registry key | What it is | What it holds |
|---|---|---|
| `shared.safes.admin` | the **Admin Safe** | every manager role in `ops/abis/v2/roles.json` `holders.adminSafe`. Protocol configuration. |
| `shared.safes.treasury` | the **Treasury Safe** | protocol money. It is the `treasury` address the vault, the keeper-rewards contract, the rewards distributor and the fee splitter pay out to, and it holds **no manager role at all**. |

Same three owner keys, on separate devices, threshold two, on both. The split is the point: the
signatures that move protocol money are not the signatures that change protocol configuration
(`v8-plan/V8-DESIGN.md` §2.4, owner decisions V3-D1 and V3-D10). One address used for both defeats
it, and `ops/markets/build-markets.mjs --check` refuses that outright
(`build-markets.mjs:928-944`): `shared.safes.admin` must equal `shared.admin`, and
`shared.safes.admin` must not equal `shared.safes.treasury`.

Role operations sent *from* the Admin Safe are `v8-roles.md`. This page is how the Safes come to
exist and how a transaction gets two signatures and lands.

## O8-02 coverage audit (T-189, 2026-09-21)

Compared with `v8-plan/tasks/O-ops.md:57-59`, the pre-T-189 version of this file covered the two-Safe
shape, release verification, raw `execTransaction`, prompt-backed `--account` signing and the
no-web-app path. It did **not** cover all of O8-02:

1. O8-02 requires every command to have been executed once on the devnet with a referenced
   transcript. The pre-T-189 file (`v8-safes.md:1-390`) named no transcript. That evidence is still
   missing and owner-gated; this edit does not invent it. A devnet run that has not happened is a
   failed evidence step, not a documentation pass.
2. The pre-T-189 factory step (`v8-safes.md:143-147`) told the reader to recover
   `createProxyWithNonce` from the chosen factory ABI but stopped before an executable simulation or
   send. It therefore described Safe creation without providing a complete raw creation command.
3. The pre-T-189 write-back (`v8-safes.md:324-340`) used an inline `node -e` hand edit. It did not go
   through the existing registry generator and could not prove the two Safes were the expected
   2-of-3 contracts before recording them.

The verifier added below closes the third gap and makes the Safe/readback and collision checks
mechanical. The first gap stays named until the owner runs the whole procedure on the devnet and
records the transcript. The second stays release-specific by design: §2 now gives the concrete
simulation/send shape, but the function signature still comes from the factory ABI proved in §1.3.

## What is verified and what is not

Read this before you plan the session. This runbook does not assert anything about chain 4663 that
you have not proved at the prompt.

| Claim | Status |
|---|---|
| Safe singleton and proxy-factory contracts are deployed on chain 4663 | **unverified here.** §1 is the command that settles it. `v8-plan/V8-DESIGN.md` §2.4 records an `eth_getCode` check on 2026-09-19 and `00-MASTER-2026-09-19.md` repeats it; neither is a check you ran. |
| The Safe **web app** (app.safe.global) lists chain 4663 | **unverified, and assumed not to.** `V8-DESIGN.md` §2.4 says so explicitly. Everything below works without it. |
| A `SafeL2` 1.4.1 at `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` is an exact-match verified contract on chain 4663 | **evidence exists outside this repository** — a Sourcify record dated 2026-09-06 under `hedgehood-contracts/verified/SafeL2_1_4_1/sourcify.json` in this workspace. It is a lead for §1, not a fact this runbook stands behind. Prove it with `cast code` and `VERSION()` before a single owner key touches it. |
| The Safe transaction format, signature ordering and `setup` arguments in §2-§4 | **read from verified 1.4.1 source**, not from memory: `hedgehood-contracts/verified/SafeL2_1_4_1/src/contracts/Safe.sol`, the Sourcify exact match above. Re-derive them from whatever singleton you actually choose (§1 step 3). |

**Creating the Safes, funding them and sending anything from them are owner-gated.** This runbook
describes the steps; it does not perform them. Nothing here is run by an agent.

---

## 0. Shell setup

```bash
# from the app repo root
REG=ops/markets/tier1.json
ROLES=ops/abis/v2/roles.json
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
eval "$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = { CHAIN: r.shared.chainId, SAFE_ADMIN: r.shared.safes.admin, SAFE_TREASURY: r.shared.safes.treasury,
  MANAGER: r.v2.contracts.accessManager, GUARDIAN: r.shared.guardian, OPS_WALLET: r.shared.opsWallet };
for (const [k, x] of Object.entries(v)) console.log(`export ${k}=${x ?? ""}`);' "$REG")"
echo "chain $CHAIN  admin ${SAFE_ADMIN:-<not created>}  treasury ${SAFE_TREASURY:-<not created>}"
cast chain-id --rpc-url $RH_RPC       # must equal $CHAIN before anything else
```

`$SAFE_ADMIN` and `$SAFE_TREASURY` are empty until §5 writes them back. An empty variable in a
`cast` command silently becomes a missing argument, so check the echo line every time.

The two addresses you will need and this repository does not carry:

```bash
SAFE_SINGLETON=0x…    # the Safe implementation, chosen in §1
SAFE_FACTORY=0x…      # the SafeProxyFactory of the same release
```

---

## 1. Prove the Safe contracts exist on this chain

Do not skip this because someone said they checked. The whole reason this runbook exists is that the
usual front end may not be available here, and the usual front end is what normally proves it.

1. **Choose a release.** The Safe project publishes the singleton and factory addresses per chain in
   its deployments registry. Take both addresses for chain 4663 from there, or from the owner's own
   record of which Safe release this deployment standardises on. Write down which release
   (1.3.0 / 1.4.1, L1 or L2 variant) you chose — §4's transaction encoding is release-specific.
2. **Prove there is code at each:**
   ```bash
   cast code $SAFE_SINGLETON --rpc-url $RH_RPC | head -c 20; echo
   cast code $SAFE_FACTORY   --rpc-url $RH_RPC | head -c 20; echo
   ```
   `0x` means nothing is deployed at that address on this chain. Stop. A Safe "created" against an
   empty factory is an address with no code behind it, and funding it loses the funds.
3. **Prove it is what it claims to be, and pull its real ABI:**
   ```bash
   cast call $SAFE_SINGLETON "VERSION()(string)" --rpc-url $RH_RPC
   cast interface $SAFE_SINGLETON --chain $CHAIN        # if a verified source is published for this chain
   ```
   `cast interface` is the mirror step: every signature in §2 and §4 should come back identical from
   the contract you are actually going to use. If it does not resolve, read the verified source for
   that address through whichever explorer this chain publishes and compare by hand — do not carry
   on with a signature typed from this page.
4. **Sanity-check that the singleton is a singleton.** Safe's own constructor sets the threshold on
   the implementation so that `setup` can never be called on it
   (`Safe.sol:72-80`, verified 1.4.1 source): *"we create a Safe with 0 owners and threshold 1. This
   is an unusable Safe, perfect for the singleton"*.
   ```bash
   cast call $SAFE_SINGLETON "getOwners()(address[])"  --rpc-url $RH_RPC    # [] on a singleton
   cast call $SAFE_SINGLETON "getThreshold()(uint256)" --rpc-url $RH_RPC    # 1 on a singleton
   ```
   Owners coming back non-empty means this is somebody's **deployed Safe**, not an implementation.
   Using it as a singleton would point both of our Safes at a contract a stranger controls.

If step 2 or 3 fails, the fall-back is to deploy the Safe contracts from their own verified source as
part of the v8 deploy, which is an owner decision and a change to `C8-10`'s deploy scripts — not
something to improvise during a Safe-creation session. Stop and report.

---

## 2. Create each Safe

Two Safes, same three owners, threshold two. Do them one at a time and finish §3 on the first before
starting the second.

**The tooling that did this on 2026-09-21 is `ops/v8/safes-bootstrap.sh` (landed by T-OP-118 from
commit `0c7b66ca6040dad81db3607d74143945fa9ade69`).** It mechanises §1–§3 and refuses where this page
says to prove something; the hand path below stays as the reference for what each command encodes.
The flow is simulate, then create, in that order and in one invocation:

```bash
ops/v8/derive-safe-owners.sh --csv                 # the three owner ADDRESSES (indices 70-72); key files
                                                    # go under ~/.callhouse-keys/v8/safe-owners/, never stdout
ops/v8/safes-bootstrap.sh probe                    # read-only: singleton, factory, fallback have code; singleton
                                                    # is an implementation (getOwners() empty, threshold 1)
ops/v8/safes-bootstrap.sh plan --owners $O1,$O2,$O3   # read-only: builds setup(), decodes it back, SIMULATES
                                                    # createProxyWithNonce for both salts and prints both addresses
# OWNER ACTION -- the invocation of record (owner-questions item 18, 2026-09-21 14:18-14:21Z):
SALT_ADMIN=2026092101 SALT_TREASURY=2026092102 \
  ops/v8/safes-bootstrap.sh create --owners $O1,$O2,$O3 --account ops
```

`create` re-runs `probe` and `plan` in the same process, prints the two predicted addresses, waits
for the literal word `create`, and sends the two `createProxyWithNonce` transactions with
`cast send --account ops` — the keystore password is prompted by cast and no key ever appears on a
command line (`safes-bootstrap.sh`, `create()`: `--account` is required and a raw key is not a
flag it accepts). The keystore itself is made by `ops/v8/import-deployer.sh` (mnemonic index 0 →
`cast wallet import`). `RH_RPC` defaults to the public RPC and is overridable; the singleton,
factory and fallback default to the canonical 1.4.1 addresses and are **candidates until `probe`
proves them** on this chain. Salts default to `<UTC date>01` / `<UTC date>02`; record the ones you
used — the deterministic-address trap below applies to the script exactly as to the hand path.

The initialiser is `setup`, whose eight arguments are, in order (verified 1.4.1 source,
`Safe.sol:95-104`):

```
setup(address[] _owners, uint256 _threshold, address to, bytes data,
      address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)
```

Use `to = address(0)`, `data = 0x`, `paymentToken = address(0)`, `payment = 0`,
`paymentReceiver = address(0)`. `to`/`data` run a delegatecall at setup time and we have nothing to
run; a non-zero `payment` pays a stranger out of the new Safe. The fallback handler is the
`CompatibilityFallbackHandler` of the same release, or `address(0)`. §4 does not need it —
`getTransactionHash` is on the Safe itself in the 1.4.1 source we read (`Safe.sol:427`) — but
EIP-1271 message signing is, so a Safe created with `address(0)` here cannot later be used to sign
messages for anything that expects it. Note which you chose.

```bash
O1=0x…  O2=0x…  O3=0x…            # the three owner addresses, from three separate devices
FALLBACK=0x…                       # the CompatibilityFallbackHandler of the chosen release, or 0x0
INIT=$(cast calldata \
  "setup(address[],uint256,address,bytes,address,address,uint256,address)" \
  "[$O1,$O2,$O3]" 2 0x0000000000000000000000000000000000000000 0x \
  $FALLBACK 0x0000000000000000000000000000000000000000 0 0x0000000000000000000000000000000000000000)
echo "$INIT"
cast decode-calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "$INIT"
```

Read that decode back out loud against the three owner addresses **before** it is broadcast. The
owner set and the threshold are what you are creating; everything else about a Safe can be changed
later by its owners, and this cannot be changed by anybody if you get it wrong and fund it.

Then deploy the proxy through the factory. Take the exact `createProxyWithNonce` signature from step
1.3's `cast interface` of `$SAFE_FACTORY` rather than from this page — the factory's function name
and argument order differ between Safe releases, and this is precisely the kind of line that looks
right and encodes something else. Whatever the call, it takes the singleton, `$INIT`, and a salt
nonce, and the address it returns is the Safe.

For a factory whose proved ABI names `createProxyWithNonce(address,bytes,uint256)`, first simulate
the exact call, then send those same arguments. A failed simulation is a failed creation step; do not
broadcast and hope the sender changes the result.

```bash
CREATE_SIG='createProxyWithNonce(address,bytes,uint256)(address)'
SALT_NONCE=<recorded-unique-integer>
cast call $SAFE_FACTORY "$CREATE_SIG" $SAFE_SINGLETON "$INIT" $SALT_NONCE --rpc-url $RH_RPC
# owner action; the keystore password is prompted and never appears on the command line
cast send $SAFE_FACTORY "$CREATE_SIG" $SAFE_SINGLETON "$INIT" $SALT_NONCE \
  --rpc-url $RH_RPC --account ops
```

If §1.3 reports a different signature, the two commands above are **wrong for that release**. Replace
`$CREATE_SIG` from the proved ABI before either command. A receipt without the factory's proxy-
creation event, or an address that fails §3, is a failed creation — never write it to the registry.

**Deploying from a key is an owner action.** The deployer is not an owner and holds nothing
afterwards; any funded key works and the Safe does not care which one created it.

### The one deterministic-address trap

`createProxyWithNonce` derives the address from the singleton, the initialiser **and** the salt
nonce. The same three owners with a different salt is a different Safe; the same salt with the owners
in a different array order is a different Safe. Record the singleton, the full `$INIT` and the salt
for each of the two Safes in the deploy notes. Deriving the address again a year later from a
half-remembered owner order is not possible.

---

## 3. Prove each new Safe before it holds anything

```bash
NEW=0x…                                   # the address the factory returned
cast code $NEW --rpc-url $RH_RPC | head -c 20; echo     # not 0x
cast call $NEW "getOwners()(address[])"  --rpc-url $RH_RPC    # exactly O1, O2, O3
cast call $NEW "getThreshold()(uint256)" --rpc-url $RH_RPC    # 2
cast call $NEW "nonce()(uint256)"        --rpc-url $RH_RPC    # 0
cast call $NEW "VERSION()(string)"       --rpc-url $RH_RPC    # the release you chose in §1
for O in $O1 $O2 $O3; do echo -n "$O "; cast call $NEW "isOwner(address)(bool)" $O --rpc-url $RH_RPC; done
```

Then prove the **owners can actually sign**, on the Safe that holds nothing, before it holds
anything. §4 with a no-op transaction — `to` = the Safe itself, `value` 0, `data` `0x` — is the
cheapest rehearsal there is, and it is the only way to find out that one of the three devices cannot
produce a signature this chain accepts while that still costs nothing.

`getThreshold()` below two, or an owner list that is not the three you meant, is not a thing to fix
later: the monitor raises `v2_mon_safe_threshold` on sight for any protocol Safe under two
signatures, with no history needed (`ops/alerts.md` §V55). Recreate the Safe instead.

### 3.1 Verify the complete four-address intake mechanically

The manual calls above are useful while creating one Safe. Before either address enters the
registry, `safes-verify.mjs` checks both Safes against one expected three-owner set, checks all four
returned OWN8-01 addresses are distinct, refuses every existing v7 address in `tier1.json` and the
frozen `v7-legacy.json`, every address in the dev/test registry, plus all twelve public Anvil
accounts derived from the devnet's own mnemonic and account count, and verifies that the role
manifest still defines `guardianKey -> GUARDIAN`.

Put **public addresses only** in a temporary file outside the repository. No private key, mnemonic,
keystore password or RPC credential belongs in this file.

```json
{
  "adminSafe": "0x…",
  "treasurySafe": "0x…",
  "guardian": "0x…",
  "opsWallet": "0x…",
  "owners": ["0x…", "0x…", "0x…"]
}
```

The default is an offline dry run. It makes no RPC call and writes nothing:

```bash
SAFE_INTAKE=/absolute/path/outside-the-repo/v8-safe-intake.json
node ops/v8/safes-verify.mjs --intake "$SAFE_INTAKE"
```

`PLAN` followed by `DRY RUN` means only the local shape, collision inventory and manifest checks
passed. `REFUSED: offline intake refused` names the input and the exact v7/dev path that collided, or
the missing manifest fact. It is not permission to write the registry.

The live readback is explicit and read-only. `RH_RPC` stays in the environment so a keyed URL never
appears in argv; `--chain-id` must agree with both the registry and `eth_chainId` before either Safe
is read:

```bash
node ops/v8/safes-verify.mjs --intake "$SAFE_INTAKE" --execute --chain-id "$CHAIN"
```

Success names both `Admin Safe` and `Treasury Safe` as exact 2-of-3 contracts. Failure names the Safe
and the missing fact: no bytecode (EOA/not deployed), a failed `getThreshold`, a threshold other than
2, a failed `getOwners`, an owner count other than 3, or a missing/unexpected owner. Silence from a
read is a refusal, never a pass.

---

## 4. Signing a transaction without the web app

Everything in `v8-roles.md` that says "one Safe transaction" means this procedure.

A Safe transaction is nine fields plus the Safe's nonce. For everything this protocol does,
`value` is 0, `operation` is 0 (a plain `CALL`, never `DELEGATECALL`), and the four gas-refund
fields are 0 with the zero address:

| Field | Value for our transactions |
|---|---|
| `to` | the contract being called — `$MANAGER` for a role operation, the target itself for a direct scheduled call (`v8-roles.md` §4.4) |
| `value` | `0` |
| `data` | the inner calldata, built with `cast calldata` |
| `operation` | `0` |
| `safeTxGas`, `baseGas`, `gasPrice` | `0` |
| `gasToken`, `refundReceiver` | `0x0000000000000000000000000000000000000000` |
| `_nonce` | the Safe's current `nonce()` |

### 4.1 Compute the hash every owner will sign

```bash
SAFE=$SAFE_ADMIN
TO=$MANAGER
DATA=$(cast calldata "revokeRole(uint64,address)" 9 0x…)      # whatever the operation is
NONCE=$(cast call $SAFE "nonce()(uint256)" --rpc-url $RH_RPC)
Z=0x0000000000000000000000000000000000000000

SAFETXHASH=$(cast call $SAFE \
  "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  $TO 0 "$DATA" 0 0 0 0 $Z $Z $NONCE --rpc-url $RH_RPC)
echo "$SAFETXHASH"
```

Every owner computes this **themselves**, from the same nine fields, on their own machine, and
compares the hash. An owner who signs a hash somebody else computed is signing whatever that person
encoded. The fields are short enough to read out on a call.

Two cross-checks worth the thirty seconds:

```bash
cast call $SAFE "domainSeparator()(bytes32)" --rpc-url $RH_RPC   # binds the signature to this Safe
cast call $SAFE "getChainId()(uint256)"      --rpc-url $RH_RPC   # and to this chain
cast decode-calldata "revokeRole(uint64,address)" "$DATA"        # and says what is actually being sent
```

The domain separator is built from the chain id and the Safe's own address
(`Safe.sol:366`, verified 1.4.1 source), so a signature collected for one Safe cannot be replayed on
the other one or on another chain. That is a reason to check it, not a reason to skip checking it.

### 4.2 Collect two signatures

Each of two owners signs `$SAFETXHASH` with their own key, on their own device:

```bash
cast wallet sign --account owner1 --no-hash "$SAFETXHASH"
```

`--no-hash` signs the 32 bytes as they are. Without it `cast` would hash them again and the Safe
would recover a different address — the signature verifies cleanly against nothing, `execTransaction`
reverts `GS026`, and it looks like the wrong owner rather than the wrong flag.

### 4.3 Concatenate them **in ascending owner-address order**

This is the step that wastes an hour when it is got wrong. The Safe walks the signature blob and
requires each recovered owner to be strictly greater than the previous one
(`Safe.sol:330`, verified 1.4.1 source: `require(currentOwner > lastOwner && owners[currentOwner] != address(0) …, "GS026")`).
Signatures assembled in the order the humans happened to reply revert with `GS026`, which says
nothing about ordering.

```bash
# SIG_A belongs to the numerically smaller owner address, SIG_B to the larger. Compare the
# ADDRESSES as numbers (lower-case hex), not the order the signatures arrived in.
SIGS=0x$(printf '%s%s' "${SIG_A#0x}" "${SIG_B#0x}")
```

### 4.4 Send it

Any address may broadcast — the signatures are the authorisation, so the sender can be an ops key
with nothing but gas:

```bash
cast send $SAFE \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)(bool)" \
  $TO 0 "$DATA" 0 0 0 0 $Z $Z "$SIGS" --rpc-url $RH_RPC --account ops
```

**Whether a failing inner call reverts depends on the fields above.** `execTransaction` ends with
`require(success || safeTxGas != 0 || gasPrice != 0, "GS013")` (`Safe.sol:207`, verified 1.4.1
source). With our `safeTxGas = 0` and `gasPrice = 0` a failing inner call **reverts the whole
transaction** with `GS013`, and the nonce is rolled back with it — so a failed operation can simply
be signed again at the same nonce. Set either field non-zero and the opposite holds: the Safe
transaction succeeds, emits `ExecutionFailure` instead of `ExecutionSuccess`, and **consumes the
nonce** while the operation never happened. That is the reason both are 0 here, and the reason not to
"just put some gas in `safeTxGas`" when a send is being awkward.

Either way, never read "the transaction landed" as "the operation happened". Check the effect:

```bash
cast call $SAFE "nonce()(uint256)" --rpc-url $RH_RPC        # incremented: the Safe transaction ran
cast receipt <txhash> --rpc-url $RH_RPC                     # ExecutionSuccess vs ExecutionFailure
# …and then the state the inner call was supposed to change (v8-roles.md §4.5)
```

### 4.5 Failure codes you will actually see

| Revert | What it means |
|---|---|
| `GS013` | the signatures were fine and the **inner call failed**, with `safeTxGas` and `gasPrice` both 0. Decode the inner revert and fix that; the Safe nonce did not move |
| `GS020` | fewer signature bytes than the threshold needs — you sent one signature for a 2-of-3 |
| `GS025` | an approved-hash entry with `v = 1` and no matching `approveHash`, or it was not sent by that owner |
| `GS026` | a recovered address that is not an owner, or signatures **out of ascending order** (§4.3), or `--no-hash` was forgotten (§4.2) |
| `GS030` | `approveHash` sent by an address that is not an owner |

### 4.6 The alternative: pre-approved hashes

An owner who cannot hand over a raw signature can instead send a transaction of their own:

```bash
cast send $SAFE "approveHash(bytes32)" "$SAFETXHASH" --rpc-url $RH_RPC --account owner2
```

and contribute a 65-byte "signature" of `v = 1`, `r` = that owner's address left-padded to 32 bytes,
`s` = 0. The Safe accepts it because the hash is approved on chain (`Safe.sol:316-321`, verified
1.4.1 source). It costs a transaction and it is public before execution, which is sometimes exactly
what you want and sometimes exactly what you do not. **An approved hash is approved forever** — the
1.4.1 source says so in its own comment on `approveHash`: there is no revocation. Approving a hash
you then decide against means burning the Safe's nonce on something harmless so the approval can
never be used.

### 4.7 `safe-cli`

`safe-cli` automates §4.1-§4.4 and is the nicer path when it is available. Installing it is an owner
action (new software on a signing machine), it needs the singleton and factory addresses from §1 just
the same, and it must be pointed at this chain's RPC rather than a hosted Safe transaction service —
there is no reason to believe one exists for 4663. The raw path above is what this runbook guarantees
will work, because every command in it is `cast` against the chain.

---

## 5. Writing the addresses back into the registry

**Done for the launch registry by T-OP-111 (§5.1 below): `tier1.json` carries both Safes, the
`shared.admin` mirror and the ops wallet, verified on chain independently of the creation
transcript.** `safes-bootstrap.sh record` / `mirror` are the tooling's own write path and were not
what wrote the registry; note that `record` assigns `shared.safes.*`, `shared.admin`, `shared.guardian`,
`shared.feeRecipient` and `shared.opsWallet` unconditionally (no non-null-conflict refusal, unlike
`safes-verify.mjs --write-back`), so do not re-run it against a registry that already carries values.

Only do this after the live command in §3.1 passes. `--write-back` repeats the live chain-id and Safe
readbacks in the same run and then invokes `ops/markets/write-back-v8.mjs`. The verifier never edits
`tier1.json` itself, never passes `--force`, and never writes generated projections by hand.

```bash
node ops/v8/safes-verify.mjs --intake "$SAFE_INTAKE" \
  --execute --chain-id "$CHAIN" --write-back
node ops/markets/build-markets.mjs --check
```

The generator writes `shared.safes.admin`, `shared.safes.treasury`, the `shared.admin` mirror,
`shared.guardian`, `shared.opsWallet` and the guardian-bot mirror together. A non-null conflicting
slot is a refusal: investigate the intake and deployment record rather than adding `--force`.
`build-markets --check` then enforces the two rules this page opened with: `shared.safes.admin` and
`shared.admin` must be equal (null included), and the two Safes must not be one address
(`ops/markets/build-markets.mjs:928-944`). It also refuses any key under `shared.safes` other than
`admin` and `treasury`. A non-zero exit or a named validator problem means the write-back is not
complete. Commit the registry before anything reads it: `ops/go-live-v2.sh` builds from a reviewed
SHA and refuses when that commit's `tier1.json` differs from the one it planned against.

Then check the roles landed where the manifest says, using the readers in `v8-roles.md` §0:

```bash
ROLES="$ROLES" node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.ROLES, "utf8"));
console.log("Admin Safe should hold:", r.holders.adminSafe.join(" "));'
# …then, per role name printed above:
cast call $MANAGER "hasRole(uint64,address)(bool,uint32)" <roleId> $SAFE_ADMIN --rpc-url $RH_RPC
```

The Treasury Safe should hold **nothing**: it is absent from `holders` in the manifest, and the
deploy check is that it is the `treasury` address on the vault, the keeper-rewards contract, the
rewards distributor and the fee splitter, not that it holds a role.

---

### 5.1 Write-back record — 2026-09-22 (T-OP-111, claude-445303)

The two Safes were created by the owner on 2026-09-21 (`ops/v8/safes-bootstrap.sh`, transcript 14:21Z; the
tooling lives in orphan commit `0c7b66ca6040dad81db3607d74143945fa9ade69`) and written into `tier1.json`
here **after** an independent on-chain verification, not from the transcript. Every read below is
against `https://rpc.mainnet.chain.robinhood.com` (`eth_chainId` 4663), head **69296028** (Safes) and
**69298796** (EOAs), 2026-09-22 02:23–02:28Z; creation transactions via Etherscan V2 `chainid=4663`
`txlist` for the deployer plus the receipts' `ProxyCreation(address,address)` logs
(topic0 `0x4f51faf6…e235`). EIP-55 re-derived strictly with `viem` `isAddress(a, {strict: true})` /
`getAddress` from `keeper/` (all eleven addresses valid; a one-letter corrupted checksum refused as the
control). The registry fields written are exactly the principals; guardian and the three bot keys are
T-OP-108's write, `shared.feeRecipient` stays `null` because it IS the FeeSplitter the deploy creates
(`DeployV8.s.sol:357-360`, owner ruling 2026-09-22: 50 % burn / 50 % treasury, matched by
`LAUNCH_BURN_BPS = 5000`).

| Safe | address (EIP-55) | created | singleton (slot 0) | `VERSION()` | `getThreshold()` | `getOwners()` | fallback handler (slot `6c9a…18d5`) | guard / modules / nonce |
|---|---|---|---|---|---|---|---|---|
| **Admin** (`shared.safes.admin`, `shared.admin`, `v2.protocolAddresses.admin`) | `0x6f8A7B77b72511cD8939596b1659bA28C28f101B` | tx `0xb61dbb854ad737d4a9daa3b7dbcf980c7447aeeb286c16713c354b49b9e23a56`, block **68864146**, saltNonce 2026092101, from idx 0 via factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` = `SAFE_L2_141` (`DeployV8.s.sol:1587`, accepted at `:1626-1637`) | `1.4.1` | **2** | exactly idx 70/71/72 (below) | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` = `SAFE_FALLBACK_141` (`:1590`) | none / none / 0 |
| **Treasury** (`shared.safes.treasury`, `v2.protocolAddresses.treasury`) | `0x014b996a084690FB27265BfAC157b04e9FeBbF4E` | tx `0x4a76ae73f5c1062a73e3b8856c6b8980cdaec6194e3dee5dd998af7ffeedcdcd`, block **68864203**, saltNonce 2026092102, same deployer and factory | same | `1.4.1` | **2** | exactly idx 70/71/72 | same | none / none / 0 |

Admin-vs-treasury assignment: owner-questions item 18 (coordinator file, 2026-09-22 ~12:20Z) — *"admin =
0x6f8A7B77b72511cD8939596b1659bA28C28f101B (salt 2026092101), treasury = 0x014b996a084690FB27265BfAC157b04e9FeBbF4E
(salt 2026092102)"*, first-created = admin, recorded from the deploy transcript. Both Safes have code (171
bytes, the 1.4.1 proxy); every EOA below has **no code**.

| idx | role | address (EIP-55) | registry field | how verified |
|---|---|---|---|---|
| 0 | deployer / AccessManager initial admin (renounced by DeployV8) | `0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b` | **none** — the wrapper takes the deployer from `DEPLOYER_PK` (`DeployV2Batch.sh:229-232`); `shared.admin` is the Admin Safe, not this key (`ops/markets/README.md:100`) | `eth_getCode` `0x`, nonce 102; sender of both creation txs |
| 70 | Safe owner 1 | `0x5E3706c385E7F7252D5C03b3c6eb82c88eBFF8b7` | none (owners live in the Safes) | `getOwners()` of both Safes; code `0x` |
| 71 | Safe owner 2 | `0xF5235EBE8953c6039b36b7db2F2D3AD5EEFC66F1` | none | same |
| 72 | Safe owner 3 | `0x4C24888237890BA4d147670EB8a0e7539C9e19B6` | none | same |
| 73 | fee-recipient key (derived) | `0x9DBdDe6f90039842f926E5aB358143d49F752da0` | **none** — `shared.feeRecipient` stays `null`: the deploy fills it with the FeeSplitter it creates | code `0x`; recorded so nobody writes it into `feeRecipient` by mistake |
| 74 | ops wallet | `0x088E22EaF42F99c8b0d9A4e9babA5EdDE78A1439` | `shared.opsWallet`, `v2.protocolAddresses.opsWallet` | code `0x`, nonce 0 |
| 60–63 | cranker / pricer / quoter / guardian | (T-OP-108's write; `0xc9924324…`, `0xD08Dd3DE…`, `0xdEd3B00a…`, `0x2875135B…`) | `v2.bots.*`, `shared.guardian` | not this row |

After the write: `node --test ops/markets/build-markets.test.mjs` **89/89** (three new T-OP-111 pins: the values,
the mirrors, distinctness from every other principal, `dev.json` keeps its anvil Safes);
`node ops/markets/build-markets.mjs --check` → `v2: 35 market blocks, 2 pools checked on chain at block 69300612,
0 problem(s)`, `no drift`. `dev.json` is **unchanged** by design: `build-markets.mjs:1608-1613` refuses a production
wallet in the dev registry, so dev keeps anvil #0 / #9 as its Safes.

## 6. What the monitor watches, once they exist

`ops/v2/monitor.mjs` reads `nonce()`, `getThreshold()` and `getOwners()` on both Safes:

- `v2_mon_safe_threshold` (`ops/alerts.md` §V55) — under two signatures, or more signatures than
  owners. It carries no history and fires on sight, so a Safe that was **already** wrong when the
  monitor was first pointed at it is caught. A Safe address with no code is reported and the check
  goes `incomplete` — never counted as healthy.
- `v2_mon_safe_config_changed` (`ops/alerts.md` §V28) — an owner added or removed, a threshold moved.
- `v2_mon_safe_nonce_changed` (`ops/alerts.md` §V28) — the Safe signed something. Informational, and
  the record you check your own session against.

A threshold or owner change nobody on the rota made means every key on that Safe is suspect:
`incident-v2.md` §5.

---

## 7. Do NOT

- Do not use a singleton or factory address you have not run `cast code` against on this chain (§1).
- Do not use `operation = 1` (`DELEGATECALL`). Nothing this protocol does needs it, and a
  delegatecall from the Safe runs arbitrary code against the Safe's own storage — including its
  owners and its threshold.
- Do not set a non-zero `payment` or `refundReceiver`. They pay somebody out of the Safe and they are
  the fields nobody reads.
- Do not let one owner compute the hash for the others (§4.1).
- Do not assemble signatures in the order they arrived (§4.3).
- Do not read a mined `execTransaction` as a successful operation. Check `ExecutionSuccess` and check
  the state (§4.4).
- Do not `approveHash` for anything you are not certain of. The approval cannot be withdrawn (§4.6).
- Do not point `shared.safes.treasury` at the Admin Safe to "keep it simple". `--check` refuses it,
  and the refusal is the design.
- Do not put a key on a command line. `--account` and a Foundry keystore, always.
