# v8 owner launch packet

The packet the owner broadcasts **from** (`OWN8-03`): the manifest of what will be deployed, the
go/no-go checklist, and the rollback. It is generated, never written by hand.

```bash
node ops/v8/launch-packet.mjs --blockers                       # what is still missing?
node ops/v8/launch-packet.mjs --rehearsal <file> --out PACKET.md
node --test ops/v8/launch-packet.test.mjs
```

## Why it is generated

A launch packet is read as an authority. If its numbers disagree with the registry, the packet wins
in the reader's head and the registry wins on chain — which is the expensive direction. So every
figure comes from a file at generation time:

| section | source |
| --- | --- |
| addresses, fees, vault limits, markets | `ops/markets/tier1.json` |
| role ids, delays, role admins, guardians, holders | `ops/abis/v2/roles.json` |
| go/no-go checklist | `ops/v8/gates.json` |
| rehearsal record | the file you bind with `--rehearsal` |

There is no address, role id, delay or fee typed into `ops/v8/launch-packet.mjs`, and
`launch-packet.test.mjs` asserts that by reading the generator's own source. The required-field list
is **imported** from `build-markets.mjs` (`V2_DEPLOYED_REQUIRED_PATHS`) rather than copied, so a
contract added to the deployment cannot go missing from the packet.

## Why it refuses

A blank in a launch document reads as "nothing to do there". The generator therefore refuses to emit
a packet at all while any required field is missing or null, and names every one of them.

Today that refusal is the useful output. The registry's whole v8 block is null — the deploy has not
happened — so `--blockers` prints the pre-broadcast worklist:

- the eleven `v2.contracts.*` addresses and the two `v2.contracts.sources.*` addresses
- `v2.flywheel.feeSplitter` and `v2.flywheel.buybackExecutor`
- `shared.safes.admin` and `shared.safes.treasury`
- `shared.feeRecipient`, `shared.opsWallet`, `shared.guardian`, `v2.deployBlock`
- the rehearsal record, until one is bound with `--rehearsal`

Those are filled by `node ops/markets/write-back-v8.mjs --deployment <file>` (O8-08A) from the
deployment record, not by hand. `<file>` is that record: the contracts batch writes it at
`broadcast/v2-batch/<STAMP>/deploy-record.json` in the contracts repository, with `<STAMP>` the stamp of the
run that produced it, and prints the full command with the real path in its summary. Re-run `--blockers`
after the write-back; an empty list is the signal that the packet can be generated.

**`--blockers` is a question, not a gate.** It exits 0 whatever it finds, because "tell me what is
missing" is not a failure. The packet path (no `--blockers`) exits non-zero while anything remains,
and that is the one to wire into a check.

## Missing and null are different, and both refuse

`build-markets.mjs` skips a required path whose value is `undefined`, delegating a missing *block* to
that block's own validator. That is correct there and wrong here: a registry with no `v2.contracts`
key at all would produce zero blockers and a confident, empty packet. The generator reports
`missing`, `null` and `empty string` as three distinct reasons and refuses on all three.

It does **not** test truthiness. `mintFeePpm: 0` and `allowRent: false` are real settings, and a
generator that called them blank would be loosened by the next person until it stopped seeing real
blanks too.

## What the checklist is and is not

Gate ids are the namespace `ops/v8/README.md` freezes: O8-13's verification report, O8-06's
rehearsal record and this checklist all cite the same ids. Do not rename them in place.

Each row states what a FAILED check looks like, derived from the catalog entry rather than written:
the pass exit set, the measured count the runner must record, and — for a gate with preconditions —
the sentence that matters most, that **an unmet precondition is REFUSED, never PASS**. `contracts.fork`
is the live example: its own catalog note records that without a fork url the suites "PASS having
asserted nothing".

Under the 2026-09-19 build-mode directive most gates have never been executed. The honest state of
most rows is NOT RUN, and the packet says so. A gate that did not run is not a pass.

## The rollback section, and the two readings that look like safety

`cancel(address caller, address target, bytes data)` takes the operation's **inputs**, not its id
(`v8-roles.md` §5). Who may send it, from AccessManager's `_canCancel`: the operation's original
caller, any ADMIN holder, or the guardian of the role that gates the target function.

Three cases, and the packet states which applies per role:

1. **A money-lane role with a guardian** — cancellable by the guardian within the role's window.
2. **A delayed role with no guardian** — ADMIN-only. `ADMIN` has no guardian and cannot be given one
   (`setRoleGuardian` reverts `AccessManagerLockedRole`), so every role grant, revoke, role-admin
   change and selector re-mapping is visible for its whole delay and undoable only by ADMIN itself.
   That is an AccessManager limit, not a policy we chose.
3. **A zero-delay role** — there is **nothing to cancel**. The call is never scheduled; it lands in
   the same block. The only undo is to revoke the role through its role admin and then reverse the
   effect. A rollback table that listed these as "cancellable by ADMIN" would tell an operator a
   brake exists where none does, which is why the generator spells this case out instead.

Two readings that look like safety and are not, both carried into the packet:

- `getSchedule` returning `0` is ambiguous — executed, cancelled, or expired. `getNonce` tells them
  apart: unchanged means cancelled or executed, higher means somebody rescheduled with a fresh full
  delay.
- `getRoleGuardian` answering `0` does not mean "no guardian". Role `0` **is** `ADMIN`, and an unset
  guardian reads back as `0` because that is the slot's zero value. A money-lane role reading `0` is
  a role whose brake was never wired — compare against the manifest column in the packet.

## Before you hand the packet to the owner

- [ ] `--blockers` prints nothing outstanding.
- [ ] The rehearsal record you bound is the one from the commit being deployed, not an older run.
- [ ] §1 Provenance names the three source files with sha256s you can reproduce.
- [ ] The checklist's NOT RUN rows match what was actually executed. Do not tick a row because it
      looks routine.
