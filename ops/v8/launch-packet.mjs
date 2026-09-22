/**
 * ops/v8/launch-packet.mjs — generate the owner launch packet (O8-07).
 *
 *   node ops/v8/launch-packet.mjs                          # emit the packet, or REFUSE and say why
 *   node ops/v8/launch-packet.mjs --out <file>             # same, written to a file
 *   node ops/v8/launch-packet.mjs --blockers               # answer "what is still missing?" and exit 0
 *   node ops/v8/launch-packet.mjs --rehearsal <file>       # bind the fork-live rehearsal record
 *   node --test ops/v8/launch-packet.test.mjs
 *
 * WHAT THIS IS. OWN8-03 is the owner broadcasting the launch, and the owner is meant to broadcast
 * FROM this packet: the manifest of what will be deployed, the go/no-go checklist, and the rollback.
 * O8-07 had no board row at all, so the packet did not exist.
 *
 * WHY IT IS GENERATED AND NOT WRITTEN. A packet whose numbers disagree with the registry is worse
 * than no packet, because it reads like an authority. Every figure here is read at run time from
 * `ops/markets/tier1.json`, `ops/abis/v2/roles.json` and `ops/v8/gates.json`. There is no address,
 * no role id, no delay and no fee typed into this file, and the tests assert that.
 *
 * WHY IT REFUSES. A blank in a launch document is read as "nothing to do there". Today the registry's
 * whole v8 block is null — the deploy has not happened — so the honest output is a refusal naming
 * every field that is still missing, which is exactly the pre-broadcast blocker list the owner needs.
 * `--blockers` asks for that list as a question; the packet path treats it as a failure and exits 1.
 *
 * THE TRAP THIS FILE IS BUILT AGAINST. The dominant defect in this build is a check that passes
 * because it cannot see its subject. Two specific shapes are guarded here and covered by tests:
 *
 *   1. `build-markets.mjs:1251` skips a required path whose value is `undefined` — deliberately, it
 *      delegates a missing BLOCK to that block's own validator. Copying that here would mean a
 *      registry missing `v2.contracts` entirely produced ZERO blockers and a confident packet. So
 *      missing and null are both refusals here, reported as distinct reasons.
 *   2. A truthiness test (`if (!value)`) would flag `mintFeePpm: 0` and `allowRent: false` as
 *      missing, and an author who then loosened it to silence those would stop seeing real blanks.
 *      `blankReason` tests for undefined, null and empty/whitespace strings only.
 *
 * The required set is IMPORTED from build-markets.mjs, never retyped. A second copy of that list is
 * a second source of truth, and the copy is the one that goes stale.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { V2_DEPLOYED_REQUIRED_PATHS } from "../markets/build-markets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const DEFAULT_REGISTRY = path.join(REPO, "ops", "markets", "tier1.json");
export const DEFAULT_ROLES = path.join(REPO, "ops", "abis", "v2", "roles.json");
export const DEFAULT_GATES = path.join(REPO, "ops", "v8", "gates.json");

/**
 * Fields the PACKET prints that the registry-completeness list does not cover. Kept separate from
 * V2_DEPLOYED_REQUIRED_PATHS on purpose: that list is the registry's own rule about what a
 * deployment must have written, and redefining it here would make this file a second authority on
 * it. This list is only "what a packet cannot be written without".
 */
export const PACKET_EXTRA_REQUIRED_PATHS = [
  "v2.interfaceVersion",
  "v2.deployBlock",
  "shared.chainId",
  "shared.usdg",
  "shared.feeRecipient",
  "shared.opsWallet",
  "shared.guardian",
  "v2.fees.premiumFeeBps",
  "v2.fees.takerFeeFlat",
  "v2.fees.takerFeeCapBps",
  "v2.fees.makerRebateBps",
  "v2.fees.exerciseFeeBps",
  "v2.vault.maxSeriesUnits",
  "v2.vault.maxTotalNotional",
  "v2.vault.maxDailyOutflow",
];

/** Every path the packet requires, registry rule first. */
export const PACKET_REQUIRED_PATHS = [...V2_DEPLOYED_REQUIRED_PATHS, ...PACKET_EXTRA_REQUIRED_PATHS];

/**
 * A generator whose required list is empty refuses nothing and emits a packet full of blanks. That
 * is a failure mode with no symptom, so it is checked at module load rather than left to a test.
 */
if (PACKET_REQUIRED_PATHS.length === 0) {
  throw new Error("launch-packet: PACKET_REQUIRED_PATHS is empty — every field would look present");
}

/** Walk a dotted path. Returns `{ found }` so a missing key is distinguishable from a null value. */
export function at(root, dotted) {
  let node = root;
  for (const key of dotted.split(".")) {
    if (node === null || node === undefined || typeof node !== "object" || !(key in node)) {
      return { found: false, value: undefined };
    }
    node = node[key];
  }
  return { found: true, value: node };
}

/**
 * Why a value cannot go in the packet, or null if it can.
 *
 * `0` and `false` are values — `mintFeePpm: 0` and `allowRent: false` are real settings — so this
 * never tests truthiness. An empty or whitespace-only string is a blank: it renders as nothing in
 * the document, which is the failure this whole tool exists to prevent.
 */
export function blankReason({ found, value }) {
  if (!found) return "missing";
  if (value === null) return "null";
  if (typeof value === "string" && value.trim() === "") return "empty string";
  return null;
}

/**
 * Every reason the packet cannot be emitted, as `{ path, reason }`, in a stable order.
 *
 * `rehearsalPath` is separate from the registry because the rehearsal record is produced at run time
 * by `ops/v2/rehearse/fork-live.mjs` and is not a committed file. Its absence is a NAMED blocker
 * rather than a quietly empty section — a packet that omits the rehearsal reads as though no
 * rehearsal was required.
 */
export function collectBlockers({ registry, roles, gates, rehearsal, rehearsalPath }) {
  const blockers = [];

  for (const p of PACKET_REQUIRED_PATHS) {
    const reason = blankReason(at(registry, p));
    if (reason) blockers.push({ path: `registry:${p}`, reason });
  }

  for (const p of ["roles", "delaysS", "roleAdmin", "roleGuardian", "holders", "targets"]) {
    const probe = at(roles, p);
    const reason = blankReason(probe);
    if (reason) blockers.push({ path: `roles:${p}`, reason });
    else if (Object.keys(probe.value ?? {}).length === 0) {
      blockers.push({ path: `roles:${p}`, reason: "empty — a role manifest with no entries would render an empty section" });
    }
  }

  // Two manifests describing different interface versions cannot both be right about one launch.
  // Only compared when BOTH sides are real values: a null version is already reported above as the
  // blank it is, and calling it a "disagreement" too would report one root cause as two blockers.
  const regIv = at(registry, "v2.interfaceVersion");
  const rolesIv = at(roles, "interfaceVersion");
  if (!blankReason(regIv) && !blankReason(rolesIv) && regIv.value !== rolesIv.value) {
    blockers.push({
      path: "interfaceVersion",
      reason: `registry says ${JSON.stringify(regIv.value)} and the role manifest says ${JSON.stringify(rolesIv.value)} — one of them is not describing this launch`,
    });
  }

  const gateList = gates?.gates;
  if (!Array.isArray(gateList) || gateList.length === 0) {
    blockers.push({ path: "gates:gates", reason: "missing or empty — a go/no-go checklist with no items reads as nothing left to check" });
  }

  if (!rehearsalPath) {
    blockers.push({ path: "rehearsal", reason: "no rehearsal record bound — pass --rehearsal <file> from ops/v2/rehearse/fork-live.mjs" });
  } else if (rehearsal === null) {
    blockers.push({ path: "rehearsal", reason: `bound record could not be read: ${rehearsalPath}` });
  }

  return blockers;
}

/** Markets the launch actually registers, counted by wave, from the registry's own rows. */
export function marketSummary(registry) {
  const rows = Array.isArray(registry?.markets) ? registry.markets : [];
  const byWave = new Map();
  const byStatus = new Map();
  for (const m of rows) {
    const wave = m?.v2?.wave ?? m?.wave ?? "(none)";
    const status = m?.v2?.status ?? "(none)";
    byWave.set(wave, (byWave.get(wave) ?? 0) + 1);
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  const routed = rows.filter((m) => m?.v2?.payoutRoute !== null && m?.v2?.payoutRoute !== undefined).length;
  return { total: rows.length, byWave, byStatus, routed, unrouted: rows.length - routed };
}

/**
 * Who can undo each role's scheduled operations, derived from the role manifest.
 *
 * AccessManager's `_canCancel` admits the original caller, any ADMIN holder, and the GUARDIAN OF THE
 * ROLE the operation was scheduled under (`ops/runbooks/v8-roles.md` §5). A role with no
 * `roleGuardian` row therefore has no third-party brake at all — ADMIN has no guardian and cannot be
 * given one, so every role grant, revoke and selector re-mapping is ADMIN-only by construction. That
 * distinction is the whole point of the rollback section, so it is stated per role rather than left
 * for the reader to work out from an absent row.
 *
 * A ZERO-DELAY ROLE HAS NOTHING TO CANCEL, and saying "cancellable by ADMIN" for one would be the
 * worst kind of wrong in a rollback document: an operator reading it believes a brake exists. Those
 * calls are not scheduled at all — they land in the same block. The only undo is to revoke the role
 * through its role admin and then reverse the effect, so that is what the row says.
 */
export function rollbackRows(roles) {
  const ids = roles?.roles ?? {};
  const delays = roles?.delaysS ?? {};
  const guardians = roles?.roleGuardian ?? {};
  const admins = roles?.roleAdmin ?? {};
  return Object.keys(ids).map((role) => {
    const guardian = guardians[role];
    const delayS = delays[role];
    const roleAdmin = admins[role] ?? "ADMIN (default)";
    let cancellableBy;
    if (delayS === 0) {
      cancellableBy =
        `NOTHING TO CANCEL — delay 0 means the call is never scheduled, it lands in the same block. ` +
        `Undo = revoke this role via ${roleAdmin}, then reverse the effect`;
    } else if (guardian) {
      cancellableBy = `the operation's original caller, any ADMIN holder, or ${guardian}`;
    } else {
      cancellableBy = "the operation's original caller or an ADMIN holder ONLY — this lane has no guardian brake";
    }
    return { role, id: ids[role], delayS, roleAdmin, guardian: guardian ?? null, cancellableBy };
  });
}

/**
 * One checklist row per gate in the catalog.
 *
 * `failedLooksLike` is required by the task contract and is derived, never typed. A gate with
 * preconditions gets the sentence that matters most: an unmet precondition is REFUSED, not PASS.
 * `contracts.fork` is the live example — its own catalog note records that without a fork url the
 * suites "PASS having asserted nothing", which is the defect class this launch is most exposed to.
 */
export function checklistRows(gates) {
  const list = Array.isArray(gates?.gates) ? gates.gates : [];
  return list.map((g) => {
    const pass = g?.exit?.pass ?? [];
    const parts = [`an exit code outside ${JSON.stringify(pass)}`];
    if (Array.isArray(g.preconditions) && g.preconditions.length > 0) {
      parts.push(
        `OR a run whose preconditions (${g.preconditions.join(", ")}) were not met — that is REFUSED, never PASS, and a PASS recorded without them asserts nothing`,
      );
    }
    if (g?.count) parts.push(`OR a missing measured count (${g.count.record})`);
    if (g?.exit?.why) parts.push(`note on the pass set: ${g.exit.why}`);
    if (g?.note) parts.push(`catalog note: ${g.note}`);
    return {
      id: g.id,
      repo: g.repo,
      command: Array.isArray(g.argv) ? g.argv.join(" ") : "",
      passExit: pass,
      failedLooksLike: parts.join(". "),
    };
  });
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Read a JSON file, returning null rather than throwing so the caller can name it as a blocker. */
export function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function provenance(file) {
  try {
    return { file: path.relative(REPO, file), sha256: sha256(readFileSync(file)) };
  } catch {
    return { file: path.relative(REPO, file), sha256: "UNREADABLE" };
  }
}

const fence = (s) => "`" + s + "`";

/** Render the packet. Callers must have checked `collectBlockers` first; this does not re-check. */
export function renderPacket({ registry, roles, gates, rehearsal, sources }) {
  const out = [];
  const w = (s = "") => out.push(s);

  w("# Stonkhouse v8 — owner launch packet");
  w();
  w("GENERATED by `ops/v8/launch-packet.mjs` (O8-07). Do not hand-edit: regenerate it. Every figure");
  w("below was read from the files in §1 at generation time, and the generator refuses to emit this");
  w("document at all if any required field is missing or null.");
  w();

  w("## 1. Provenance");
  w();
  w("| source | sha256 |");
  w("| --- | --- |");
  for (const s of sources) w(`| ${fence(s.file)} | ${fence(s.sha256)} |`);
  w();
  w(`- registry generated at: ${fence(String(registry.generatedAt))}, verified at block ${fence(String(registry.verifiedAtBlock))}`);
  w(`- interface version: ${fence(String(at(registry, "v2.interfaceVersion").value))} (registry and role manifest agree)`);
  w(`- gate catalog: ${fence(String(gates.gates.length))} gates, source ${fence(String(gates.source))}`);
  w();

  w("## 2. Manifest — what will be deployed");
  w();
  w("### 2.1 Chain and shared");
  w();
  w("| field | value |");
  w("| --- | --- |");
  for (const p of ["shared.chainId", "shared.usdg", "shared.feeRecipient", "shared.opsWallet", "shared.guardian", "shared.safes.admin", "shared.safes.treasury"]) {
    w(`| ${fence(p)} | ${fence(String(at(registry, p).value))} |`);
  }
  w();
  w("`shared.feeRecipient` IS `v2.flywheel.feeSplitter` — one address under two keys, declared in the");
  w("registry's own alias list (`build-markets.mjs` `V2_PROTOCOL_ALIASES`). If those two ever differ,");
  w("the registry validator refuses before this packet is reached.");
  w();

  w("### 2.2 Contracts");
  w();
  w("| field | address |");
  w("| --- | --- |");
  for (const p of V2_DEPLOYED_REQUIRED_PATHS) w(`| ${fence(p)} | ${fence(String(at(registry, p).value))} |`);
  w(`| ${fence("v2.deployBlock")} | ${fence(String(at(registry, "v2.deployBlock").value))} |`);
  w();
  w("This is the registry's own required set (`V2_DEPLOYED_REQUIRED_PATHS`), imported rather than");
  w("copied, so a contract added to the deployment cannot go missing from this table.");
  w();

  w("### 2.3 Roles, delays and brakes");
  w();
  w("| role | id | execution delay (s) | role admin | guardian |");
  w("| --- | --- | --- | --- | --- |");
  for (const r of rollbackRows(roles)) {
    w(`| ${fence(r.role)} | ${r.id} | ${r.delayS} | ${fence(r.roleAdmin)} | ${r.guardian ? fence(r.guardian) : "**none**"} |`);
  }
  w();
  w("Holders, from the manifest:");
  w();
  for (const [holder, list] of Object.entries(roles.holders ?? {})) w(`- ${fence(holder)}: ${list.map(fence).join(", ")}`);
  w();

  w("### 2.4 Fees and vault limits");
  w();
  w("| field | value |");
  w("| --- | --- |");
  for (const [k, v] of Object.entries(registry.v2.fees ?? {})) w(`| ${fence("v2.fees." + k)} | ${fence(String(v))} |`);
  for (const [k, v] of Object.entries(registry.v2.vault ?? {})) w(`| ${fence("v2.vault." + k)} | ${fence(String(v))} |`);
  w();

  w("### 2.5 Markets");
  w();
  const ms = marketSummary(registry);
  w(`- ${ms.total} rows in the registry.`);
  w(`- by wave: ${[...ms.byWave].map(([k, n]) => `${k} ${n}`).join(", ")}`);
  w(`- by \`v2.status\`: ${[...ms.byStatus].map(([k, n]) => `${k} ${n}`).join(", ")}`);
  w(`- payout route decided: ${ms.routed}; recorded null: ${ms.unrouted}.`);
  w();
  w("A `null` payout route is a decision, not a gap — `V2_PAYOUT_ROUTE_DELIBERATELY_NULL` in");
  w("`build-markets.mjs` names the markets that carry one on purpose. The launch does not need the");
  w("routes fresh; the buyback does (`ops/markets/PAYOUT-ROUTES-V8.md`).");
  w();

  w("## 3. Go / no-go checklist");
  w();
  w("Gate ids are the namespace `ops/v8/README.md` freezes: O8-13's verification report, O8-06's");
  w("rehearsal record and this checklist all cite the same ids. Do not rename them in place.");
  w();
  w("**A gate that did not run is not a pass.** Under the 2026-09-19 build-mode directive most of");
  w("these have never been executed, so the honest state of most rows below is NOT RUN.");
  w();
  const rows = checklistRows(gates);
  let lastRepo = null;
  let section = 0;
  for (const r of rows) {
    if (r.repo !== lastRepo) {
      w();
      section += 1;
      const repoName = gates.repos?.[r.repo];
      w(`### 3.${section} ${r.repo}${repoName ? ` — ${repoName}` : ""}`);
      w();
      lastRepo = r.repo;
    }
    w(`- [ ] ${fence(r.id)} — ${fence(r.command)}`);
    w(`      FAILED looks like: ${r.failedLooksLike}`);
  }
  w();

  w("## 4. Rehearsal record");
  w();
  w("```");
  w(String(rehearsal).trim());
  w("```");
  w();

  w("## 5. Rollback");
  w();
  w("`cancel(address caller, address target, bytes data)` takes the operation's INPUTS, not its id");
  w("(`ops/runbooks/v8-roles.md` §5). Who may send it, from AccessManager's `_canCancel`: the");
  w("operation's original caller, any ADMIN holder, or the guardian of the role that gates the target");
  w("function.");
  w();
  w("| role | cancellable by | window (s) |");
  w("| --- | --- | --- |");
  for (const r of rollbackRows(roles)) w(`| ${fence(r.role)} | ${r.cancellableBy} | ${r.delayS} |`);
  w();
  w("**The guardian cannot cancel a role or mapping change.** `ADMIN` has no guardian and cannot be");
  w("given one — `setRoleGuardian` reverts `AccessManagerLockedRole` for it. So every role grant,");
  w("revoke, role-admin change and selector re-mapping is visible for its whole delay and can be");
  w("undone only by ADMIN itself. That is an AccessManager limit, not a policy choice.");
  w();
  w("Two readings that look like safety and are not:");
  w();
  w("- `getSchedule` returning 0 is ambiguous — executed, cancelled, or expired. `getNonce` tells");
  w("  them apart: unchanged means cancelled or executed, higher means somebody rescheduled with a");
  w("  fresh full delay.");
  w("- `getRoleGuardian` answering 0 does not mean \"no guardian\". Role 0 IS `ADMIN`, and an unset");
  w("  guardian reads back as 0 because that is the slot's zero value. A money-lane role reading 0");
  w("  here is a role whose brake was never wired — compare against the manifest column above.");
  w();
  w("Operations that are NOT cancellable at all, because they are not scheduled: anything a hot key");
  w("does under a zero-delay role. Those are undone by revoking the role through `OPS_ADMIN`, which");
  w("is itself zero-delay, and then reversing the action.");
  w();

  return out.join("\n") + "\n";
}

export function parseArgs(argv) {
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    registryPath: opt("--registry", DEFAULT_REGISTRY),
    rolesPath: opt("--roles", DEFAULT_ROLES),
    gatesPath: opt("--gates", DEFAULT_GATES),
    rehearsalPath: opt("--rehearsal", null),
    outPath: opt("--out", null),
    blockersOnly: argv.includes("--blockers"),
  };
}

export function run(argv, { log = console.log, err = console.error, write = writeFileSync } = {}) {
  const args = parseArgs(argv);

  const registry = readJsonOrNull(args.registryPath);
  const roles = readJsonOrNull(args.rolesPath);
  const gates = readJsonOrNull(args.gatesPath);

  for (const [name, value, file] of [["registry", registry, args.registryPath], ["roles", roles, args.rolesPath], ["gates", gates, args.gatesPath]]) {
    if (value === null) {
      err(`launch-packet: REFUSED — ${name} could not be read or parsed: ${file}`);
      return 1;
    }
  }

  let rehearsal = null;
  if (args.rehearsalPath) {
    try {
      rehearsal = readFileSync(args.rehearsalPath, "utf8");
    } catch {
      rehearsal = null;
    }
  }

  const blockers = collectBlockers({ registry, roles, gates, rehearsal, rehearsalPath: args.rehearsalPath });

  if (args.blockersOnly) {
    if (blockers.length === 0) {
      log("launch-packet: no blockers — the packet can be generated.");
      return 0;
    }
    log(`launch-packet: ${blockers.length} blocker(s) between here and a launch packet.`);
    log("");
    for (const b of blockers) log(`  ${b.path}  —  ${b.reason}`);
    log("");
    log("This is a question answered, not a gate: it exits 0 whatever it finds. Generate the packet");
    log("(no --blockers) to get a non-zero exit while any of these remain.");
    return 0;
  }

  if (blockers.length > 0) {
    err(`launch-packet: REFUSED — ${blockers.length} required field(s) missing or null. A packet with a`);
    err("blank in it reads as 'nothing to do there', so none is written.");
    err("");
    for (const b of blockers) err(`  ${b.path}  —  ${b.reason}`);
    err("");
    err("Run with --blockers for the same list as a plain query.");
    return 1;
  }

  const sources = [args.registryPath, args.rolesPath, args.gatesPath, args.rehearsalPath].filter(Boolean).map(provenance);
  const packet = renderPacket({ registry, roles, gates, rehearsal, sources });

  if (args.outPath) {
    write(args.outPath, packet);
    log(`launch-packet: wrote ${args.outPath} (${packet.length} bytes)`);
  } else {
    log(packet);
  }
  return 0;
}

// Same guard shape as ledger.mjs and verify-gates.mjs in this directory. `process.argv[1]` is
// undefined under `node -e`, so it is tested first: resolving undefined throws, and the module would
// crash on import before any caller ran.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
