/**
 * OWN8-06 listing calendar (T-195). The owner registers the launch markets and sets their payout
 * routes through the AccessManager: `schedule` -> wait the role's delay -> `execute`. A registration
 * is a LISTING operation and a route is a CONFIG_ADMIN one, and those two delays differ by a factor
 * of twenty-four. At twenty markets that is a scheduling problem a person does by hand once and gets
 * wrong once, so this module emits the calendar: per market, the exact operation, its delay class,
 * the earliest moment it can execute, the latest moment it can still be scheduled for a chosen
 * launch, and the readback that proves it took effect.
 *
 * IT IS READ-ONLY AND IT MAKES NO NETWORK CALLS. It emits a plan and grades readbacks the owner has
 * already taken; it never signs, schedules, executes or broadcasts anything. There is no --execute
 * flag to forget, because there is no path in this file that could act.
 *
 * EVERY NUMBER IS MIRRORED, NONE IS RE-DERIVED:
 *   - the delays come from `ops/abis/v2/roles.json` `delaysS` (LISTING, CONFIG_ADMIN), the same file
 *     the deploy script wires the manager from. A delay typed into this file would be a second
 *     opinion about a value the chain already holds;
 *   - the role for each selector comes from that file's `targets` map, by exact signature. An
 *     unmapped selector is an error here, not a default: in AccessManager an unmapped restricted
 *     selector falls to ADMIN (48 h), so silently guessing LISTING would put a market on the
 *     calendar a day and a half before it could execute;
 *   - the call signatures and the readback return shapes are read out of the ABI JSON in
 *     `ops/abis/v2/`, so a signature that changes upstream breaks this file instead of drifting;
 *   - the market set comes from `ops/markets/tier1.json` and the count is counted from it. There is
 *     no market list and no "20" in this file.
 *
 * THE FAILURE THIS FILE IS BUILT AGAINST is the one that dominates this build: a check that passes
 * because it cannot see its subject. An unregistered market decodes as an all-zero MarketConfig and
 * an unset route decodes as `Venue.None`; both are *successful* eth_calls. So every readback here
 * asserts a positive fact (`enabled == true` AND the exact `strikeTick`; `venue == v4` AND the exact
 * fee and tick spacing) and every grade for a subject that is simply missing from the observation
 * file is NOT-APPLIED, never PASS. `gradeReadbacks` is the same code path in both directions.
 *
 * ROUTES ARE FLAGGED, NOT SCHEDULED, UNLESS FRESH EVIDENCE SAYS THE POOL IS THERE. The registry's
 * `payoutRoute` rows are provisional by their own document (`ops/markets/PAYOUT-ROUTES-V8.md`: the
 * measurement made zero network calls and is re-run immediately before OWN8-06). A route set to a
 * pool that no longer qualifies does not revert at `setRouteV4` time in any way the owner would
 * notice a day later - it converts winning calls over a venue nobody re-checked. So a routed market
 * is scheduled only when the evidence file says that exact `poolId` exists with the parameters the
 * registry publishes, and anything else - no evidence file, market absent from it, stale
 * measurement, mismatched pool, hooked pool, out-of-band fee - is a flagged row and a non-zero exit.
 *
 * A `payoutRoute` of `null` is NOT a flag. It is the documented in-kind payout (14 of the launch
 * markets carry a route and the rest deliberately do not), so those markets appear in the calendar
 * as an explicit in-kind row rather than being dropped - a market missing from the output would be
 * indistinguishable from a market nobody thought about.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_ROUTE_FEE_TIER, ROUTE_VENUES, UsageError, parsePayoutRoute } from "../v2/monitor.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_REGISTRY = path.join(ROOT, "ops", "markets", "tier1.json");
export const DEFAULT_ROLES = path.join(ROOT, "ops", "abis", "v2", "roles.json");
export const ABI_DIR = path.join(ROOT, "ops", "abis", "v2");

/**
 * The waves an EXPLICIT `--wave` run defaults to. THIS IS NO LONGER THE LAUNCH SET (T-OP-003).
 *
 * It used to be: {launchMarkets} filtered `market.v2.wave` against this and called the result the
 * launch set. Under the owner ruling of 2026-09-21 the launch is NVDA and SPCX, and these two waves
 * resolve to NVDA plus the nineteen `wave1` markets -- twenty, not two -- so a calendar built from
 * them silently leaves SPCX out and schedules eighteen markets nobody is launching. Waves mean
 * rollout ORDER; the launch set is named explicitly in the registry's `launchSet` block and is what
 * {launchMarkets} now reads by default.
 *
 * Kept, because a wave-scoped calendar is still a legitimate thing to ask for with `--wave`.
 */
export const LAUNCH_WAVES = Object.freeze(["canary", "wave1"]);

/** Uniswap v4 dynamic-fee flag. `setRouteV4` rejects it; mirrored from PAYOUT-ROUTES-V8.md's filter. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/** The zero address, as a v4 `PoolKey.hooks` must be for the route's poolId to be the one we pinned. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The three operations OWN8-06 schedules. `readback` names the view that proves the write landed and
 * the fields that must match; `argsFrom` pulls the arguments out of the registry row so no argument
 * is ever typed twice.
 */
export const OPERATIONS = Object.freeze({
  register: Object.freeze({
    id: "register",
    contract: "Clearinghouse",
    registryAddress: "v2.contracts.clearinghouse",
    signature: "registerMarket(address,uint64,bool)",
    readbackFn: "market",
    what: "register the market and enable it in one call (`enabled` is the third argument)",
  }),
  "route-v4": Object.freeze({
    id: "route-v4",
    contract: "PayoutRouter",
    // INTERFACE_VERSION 8 keeps the v7 key and points it at the PayoutRouter (ops/v2/monitor.mjs:3647,
    // V8-DESIGN section 6A). Reading `v2.contracts.payoutRouter` would find nothing and print an
    // unset address for a contract the registry does name.
    registryAddress: "v2.contracts.payoutAdapter",
    signature: "setRouteV4(address,uint24,int24)",
    readbackFn: "routes",
    what: "pin the v4 pool the Clearinghouse may sell a winning call's Stock Tokens through",
  }),
  "route-v3": Object.freeze({
    id: "route-v3",
    contract: "PayoutRouter",
    registryAddress: "v2.contracts.payoutAdapter",
    signature: "setRouteV3(address,uint24)",
    readbackFn: "routes",
    what: "pin the v3 pool the Clearinghouse may sell a winning call's Stock Tokens through",
  }),
});

/**
 * How stale the route measurement may be before every routed market is flagged. O8-03 says the data
 * "must be fresh when routes are set: rerun right before OWN8-06" without naming a number, so this
 * is a judgement and is stated as one: a route waits 24 h between schedule and execute, so evidence
 * older than that day was taken before an equivalent window of trading it never saw.
 */
export const DEFAULT_MAX_EVIDENCE_AGE_S = 86_400;

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** `a.b.c` out of an object, or null. Used for the registry's address pointers, which are null until deploy. */
export function dig(object, dotted) {
  let node = object;
  for (const key of dotted.split(".")) {
    if (node === null || node === undefined || typeof node !== "object") return null;
    node = node[key];
  }
  return node ?? null;
}

/**
 * The ABI entry for a call, found by the canonical signature rather than by name: `setRouteV3` and
 * `setRouteV4` differ only in their arguments, and a name-only lookup would happily return the wrong
 * one. Throws when the ABI does not carry it, so a renamed function fails here rather than producing
 * a calendar of calls that do not exist.
 */
export function abiEntry(abi, signature) {
  const entries = Array.isArray(abi) ? abi : (abi?.abi ?? []);
  for (const entry of entries) {
    if (entry?.type !== "function") continue;
    if (canonicalSignature(entry) === signature) return entry;
  }
  throw new UsageError(`ABI has no function ${signature}`);
}

/** `name(type,type)` for an ABI entry, with tuples expanded the way cast and the ABI spec write them. */
export function canonicalSignature(entry) {
  return `${entry.name}(${(entry.inputs ?? []).map(abiType).join(",")})`;
}

/** The return-type list cast needs to decode a view: `(bool,uint64,...)`, tuples expanded in place. */
export function returnSignature(entry) {
  const outputs = entry.outputs ?? [];
  if (outputs.length === 0) return "";
  return `(${outputs.map(abiType).join(",")})`;
}

function abiType(param) {
  if (!param.type.startsWith("tuple")) return param.type;
  const inner = (param.components ?? []).map(abiType).join(",");
  return `(${inner})${param.type.slice("tuple".length)}`;
}

/** Index of a named field in a tuple output, so a readback expectation points at a position cast prints. */
export function tupleFieldIndex(entry, field) {
  const output = (entry.outputs ?? [])[0];
  const components = output?.components ?? [];
  const index = components.findIndex((c) => c.name === field);
  if (index < 0) {
    throw new UsageError(`${entry.name} does not return a field named ${field}; it returns ${components.map((c) => c.name).join(", ") || "no tuple"}`);
  }
  return index;
}

/**
 * The manager role for an exact selector. An unmapped selector is refused rather than defaulted:
 * `roles.json` notes that an unmapped restricted selector falls to ADMIN, which is a different delay
 * and a different signer set, and a calendar that quietly assumed LISTING would be wrong by 47 hours.
 */
export function roleOf(roles, contract, signature) {
  const target = roles?.targets?.[contract];
  if (!target) throw new UsageError(`roles.json has no target ${contract}`);
  const role = target[signature];
  if (!role) {
    throw new UsageError(
      `roles.json maps no role to ${contract}.${signature}; an unmapped restricted selector falls to ADMIN, so this must be fixed in the manifest rather than assumed here`,
    );
  }
  return role;
}

/** The role's execution delay in seconds, from the same manifest. Missing is an error, not a zero. */
export function delayOf(roles, role) {
  const delay = roles?.delaysS?.[role];
  if (!Number.isInteger(delay)) {
    throw new UsageError(`roles.json delaysS has no integer delay for ${role}`);
  }
  return delay;
}

/**
 * The launch set, read from the registry rather than inferred from it.
 *
 * DEFAULT (`waves` null or omitted): the registry's `launchSet.markets`, which names tickers. That
 * block exists because neither `wave` nor `status` can express the launch set -- see its `note` in
 * ops/markets/tier1.json and the validator in ops/markets/build-markets.mjs. A market named there
 * that the registry does not carry is an error, not a market quietly skipped.
 *
 * WITH `waves` (an explicit `--wave` run): the old behaviour, filtering `market.v2.wave`. Every
 * market must carry a `v2.wave`; one that does not is an error rather than a market quietly left off
 * the calendar.
 */
export function launchMarkets(registry, waves = null) {
  const markets = registry?.markets;
  if (!Array.isArray(markets)) throw new UsageError("registry has no markets array");

  if (waves === null) {
    const named = registry?.launchSet?.markets;
    if (!Array.isArray(named) || named.length === 0) {
      throw new UsageError(
        "registry has no launchSet.markets; the launch set is named explicitly and is NOT derived from wave or status "
        + "(ops/markets/build-markets.mjs validateLaunchSet). Pass --wave to build a wave-scoped calendar instead.",
      );
    }
    const byTicker = new Map(markets.map((m) => [m?.ticker, m]));
    return named.map((ticker) => {
      const market = byTicker.get(ticker);
      if (market === undefined) {
        throw new UsageError(`launchSet names ${ticker}, which is not a market in this registry; the calendar would be short and read as complete`);
      }
      return market;
    });
  }

  const wanted = new Set(waves);
  const selected = [];
  for (const market of markets) {
    const wave = market?.v2?.wave;
    if (wave === undefined || wave === null || wave === "") {
      throw new UsageError(`registry market ${market?.ticker ?? "(unnamed)"} has no v2.wave; it cannot be included or excluded`);
    }
    if (wanted.has(wave)) selected.push(market);
  }
  if (selected.length === 0) {
    throw new UsageError(`no registry market is in wave(s) ${[...wanted].join(", ")}; the calendar would be empty and that is a defect, not an empty launch`);
  }
  return selected;
}

/** The registration argument tuple, straight from the registry row. A missing strikeTick is fatal. */
export function registrationArgs(market) {
  const asset = market?.asset;
  if (typeof asset !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    throw new UsageError(`market ${market?.ticker ?? "(unnamed)"}: asset is not an address (${JSON.stringify(asset)})`);
  }
  const strikeTick = market?.v2?.strikeTick;
  if (typeof strikeTick !== "string" || !/^[0-9]+$/.test(strikeTick)) {
    throw new UsageError(`market ${market.ticker}: v2.strikeTick is not a decimal string (${JSON.stringify(strikeTick)})`);
  }
  return { asset, strikeTick, enabled: true };
}

/**
 * Whether the evidence file lets this market's route be scheduled. Returns a reason on every refusal
 * and `null` only when the pool the registry pins was measured, exists, and matches - absence of an
 * entry is a refusal, never a pass.
 */
export function routeEvidenceRefusal(route, market, evidence, { nowS, maxAgeS }) {
  if (evidence === null) {
    return "no route evidence supplied (--routes-evidence): the registry's payoutRoute rows are provisional by their own document and are re-measured immediately before OWN8-06";
  }
  const measuredAtS = isoToSeconds(evidence.measuredAt, "routes evidence measuredAt");
  const ageS = nowS - measuredAtS;
  if (ageS > maxAgeS) {
    return `route evidence is ${Math.floor(ageS / 3600)} h old (measured ${evidence.measuredAt}); the freshness bound is ${Math.floor(maxAgeS / 3600)} h`;
  }
  const pools = Array.isArray(evidence.pools) ? evidence.pools : null;
  if (pools === null) return "route evidence has no pools array";
  const observed = pools.find((p) => sameAddress(p?.asset, market.asset) || p?.ticker === market.ticker);
  if (!observed) return `market is absent from the route evidence (${pools.length} pools measured); an absent pool is not a present one`;
  if (observed.exists !== true) return `route evidence records exists=${JSON.stringify(observed.exists)} for this pool`;
  if (route.venue === "v4") {
    if (!sameHex(observed.poolId, route.poolId)) {
      return `route evidence poolId ${observed.poolId ?? "(absent)"} is not the registry's ${route.poolId}`;
    }
    if (observed.tickSpacing !== route.tickSpacing) {
      return `route evidence tickSpacing ${JSON.stringify(observed.tickSpacing)} is not the registry's ${route.tickSpacing}`;
    }
    if (observed.hooks !== undefined && !sameAddress(observed.hooks, ZERO_ADDRESS)) {
      return `route evidence hooks ${observed.hooks} is not the zero address; a hooked pool has a different PoolKey and a different poolId, and setRouteV4 rejects it`;
    }
  }
  if (observed.fee !== route.fee) {
    return `route evidence fee ${JSON.stringify(observed.fee)} is not the registry's ${route.fee}`;
  }
  const feeRefusal = feeFilterRefusal(route.fee);
  if (feeRefusal) return feeRefusal;
  return null;
}

/** The fee half of `setRouteV4`'s own filter, mirrored from PAYOUT-ROUTES-V8.md's statement of it. */
export function feeFilterRefusal(fee) {
  if (!Number.isInteger(fee) || fee <= 0) return `fee ${JSON.stringify(fee)} is not a positive integer; setRouteV4 rejects a zero fee`;
  if ((fee & DYNAMIC_FEE_FLAG) !== 0) return `fee ${fee} carries the dynamic-fee flag (0x800000), which setRouteV4 rejects`;
  if (fee > MAX_ROUTE_FEE_TIER) return `fee ${fee} is above MAX_ROUTE_FEE_TIER ${MAX_ROUTE_FEE_TIER}`;
  return null;
}

const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const sameHex = sameAddress;

export function isoToSeconds(iso, where) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) throw new UsageError(`${where}: ${JSON.stringify(iso)} is not an ISO-8601 instant`);
  return Math.floor(ms / 1000);
}

export const secondsToIso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The calendar. One row per market per operation, plus the derived launch instant: the earliest
 * moment at which every scheduled operation could already have executed.
 */
export function buildCalendar({
  registry,
  roles,
  evidence = null,
  waves = null,
  startS,
  launchAtS = null,
  expirationS = null,
  maxEvidenceAgeS = DEFAULT_MAX_EVIDENCE_AGE_S,
  abis = loadAbis(),
}) {
  const markets = launchMarkets(registry, waves);

  const addresses = {};
  for (const op of Object.values(OPERATIONS)) addresses[op.contract] = dig(registry, op.registryAddress);
  addresses.adminSafe = dig(registry, "shared.safes.admin");
  addresses.accessManager = dig(registry, "v2.contracts.accessManager");
  addresses.rpc = registry?.rpc ?? null;
  addresses.chainId = dig(registry, "shared.chainId");

  const rows = [];
  for (const market of markets) {
    rows.push(registrationRow(market, roles, abis, startS, expirationS, addresses));
    rows.push(routeRow(market, roles, abis, evidence, { nowS: startS, maxAgeS: maxEvidenceAgeS }, startS, expirationS, addresses));
  }

  const scheduled = rows.filter((r) => r.status === "scheduled");
  const earliestLaunchS = scheduled.length === 0 ? null : Math.max(...scheduled.map((r) => r.earliestExecuteAtS));
  const targetLaunchS = launchAtS ?? earliestLaunchS;

  for (const row of rows) {
    if (row.status !== "scheduled" || targetLaunchS === null) continue;
    // The one number a person gets wrong by hand: a 24 h operation aimed at a launch must be
    // scheduled a day before it, and the 1 h one an hour before it.
    row.scheduleByS = targetLaunchS - row.delayS;
    row.tooLate = row.scheduleByS < startS;
  }

  return {
    // `waves` is null on the default path, where the set came from `launchSet` and no wave was
    // consulted. Recording the SOURCE rather than an empty array, so a report cannot read as "generated
    // for no waves" when it was generated for the named launch set.
    generatedFrom: { source: waves === null ? "launchSet" : "waves", waves: waves === null ? [] : [...waves], markets: markets.length },
    startS,
    earliestLaunchS,
    targetLaunchS,
    expirationS,
    evidence: evidence === null ? null : { measuredAt: evidence.measuredAt ?? null, block: evidence.block ?? null, pools: Array.isArray(evidence.pools) ? evidence.pools.length : null },
    addresses,
    rows,
    counts: {
      markets: markets.length,
      scheduled: scheduled.length,
      flagged: rows.filter((r) => r.status === "flagged").length,
      inKind: rows.filter((r) => r.status === "in-kind").length,
      tooLate: rows.filter((r) => r.tooLate).length,
      addressUnset: rows.filter((r) => r.targetAddress === null).length,
    },
  };
}

function registrationRow(market, roles, abis, startS, expirationS, addresses) {
  const op = OPERATIONS.register;
  const args = registrationArgs(market);
  const role = roleOf(roles, op.contract, op.signature);
  const delayS = delayOf(roles, role);
  const entry = abiEntry(abis[op.contract], op.signature);
  const readbackEntry = abiEntry(abis[op.contract], `${op.readbackFn}(address)`);
  return finishRow({
    ticker: market.ticker,
    asset: args.asset,
    operation: op.id,
    contract: op.contract,
    signature: canonicalSignature(entry),
    args: [args.asset, args.strikeTick, "true"],
    role,
    delayS,
    status: "scheduled",
    reason: null,
    what: op.what,
    readback: {
      contract: op.contract,
      call: `${op.readbackFn}(address)`,
      returns: returnSignature(readbackEntry),
      args: [args.asset],
      expect: [
        { field: "enabled", equals: true, index: tupleFieldIndex(readbackEntry, "enabled") },
        { field: "strikeTick", equals: args.strikeTick, index: tupleFieldIndex(readbackEntry, "strikeTick") },
      ],
      // The false-green this wording exists to stop: an unregistered market is not a revert.
      failsWhen:
        "the call reverts, or returns an all-zero MarketConfig (an UNREGISTERED market decodes cleanly as zeros, so 'it returned something' is not the test), or enabled is false, or strikeTick is not the registry's value",
    },
  }, startS, expirationS, addresses);
}

function routeRow(market, roles, abis, evidence, freshness, startS, expirationS, addresses) {
  const parsed = parsePayoutRoute(market?.v2?.payoutRoute ?? null, `markets[${market.ticker}].v2.payoutRoute`);
  const asset = registrationArgs(market).asset;

  if (parsed === null) {
    return finishRow({
      ticker: market.ticker,
      asset,
      operation: "route",
      contract: OPERATIONS["route-v4"].contract,
      signature: null,
      args: [],
      role: null,
      delayS: null,
      status: "in-kind",
      reason: "the registry publishes no payoutRoute for this market: winning calls are paid IN KIND, which is a documented outcome and not a missing row",
      what: "no route operation",
      readback: {
        contract: OPERATIONS["route-v4"].contract,
        call: "routes(address)",
        returns: returnSignature(abiEntry(abis.PayoutRouter, "routes(address)")),
        args: [asset],
        expect: [{ field: "venue", equals: 0, index: tupleFieldIndex(abiEntry(abis.PayoutRouter, "routes(address)"), "venue") }],
        failsWhen: `venue is anything but 0 (${ROUTE_VENUES[0]}): a route nobody in the registry named is converting this market's payouts`,
      },
    }, startS, expirationS, addresses);
  }

  const op = parsed.venue === "v4" ? OPERATIONS["route-v4"] : OPERATIONS["route-v3"];
  const role = roleOf(roles, op.contract, op.signature);
  const delayS = delayOf(roles, role);
  const entry = abiEntry(abis[op.contract], op.signature);
  const readbackEntry = abiEntry(abis[op.contract], "routes(address)");
  const refusal = routeEvidenceRefusal(parsed, market, evidence, freshness);
  const venueId = Number(Object.entries(ROUTE_VENUES).find(([, name]) => name === parsed.venue)?.[0] ?? NaN);
  if (!Number.isInteger(venueId)) throw new UsageError(`IPayoutRouter.Venue has no id for ${parsed.venue}`);

  const expect = [
    { field: "venue", equals: venueId, index: tupleFieldIndex(readbackEntry, "venue") },
    { field: "fee", equals: parsed.fee, index: tupleFieldIndex(readbackEntry, "fee") },
  ];
  if (parsed.venue === "v4") {
    expect.push({ field: "tickSpacing", equals: parsed.tickSpacing, index: tupleFieldIndex(readbackEntry, "tickSpacing") });
  }

  return finishRow({
    ticker: market.ticker,
    asset,
    operation: op.id,
    contract: op.contract,
    signature: canonicalSignature(entry),
    args: parsed.venue === "v4" ? [asset, String(parsed.fee), String(parsed.tickSpacing)] : [asset, String(parsed.fee)],
    role,
    delayS,
    status: refusal === null ? "scheduled" : "flagged",
    reason: refusal,
    what: op.what,
    poolId: parsed.poolId,
    readback: {
      contract: op.contract,
      call: "routes(address)",
      returns: returnSignature(readbackEntry),
      args: [asset],
      expect,
      failsWhen: `venue is 0 (${ROUTE_VENUES[0]}) - an UNSET route decodes as a clean zero, so the check asserts the venue id and the exact parameters rather than the absence of a revert - or any pinned parameter differs`,
    },
  }, startS, expirationS, addresses);
}

function finishRow(row, startS, expirationS, addresses) {
  const full = {
    scheduleByS: null,
    tooLate: false,
    poolId: null,
    ...row,
    // The address the operation is sent to, resolved from the registry. Null until OWN8-03's
    // write-back fills `v2.contracts`, and null is reported rather than papered over: a calendar
    // whose target is unknown is a rehearsal, not an executable plan.
    targetAddress: addresses?.[row.contract] ?? null,
    scheduleAtS: row.status === "scheduled" ? startS : null,
    earliestExecuteAtS: row.status === "scheduled" ? startS + row.delayS : null,
  };
  full.expiresAtS = full.earliestExecuteAtS !== null && expirationS !== null ? full.earliestExecuteAtS + expirationS : null;
  return full;
}

/** The ABI JSON each operation and readback is read out of. Kept separate so tests can inject. */
export function loadAbis(dir = ABI_DIR) {
  return {
    Clearinghouse: readJson(path.join(dir, "Clearinghouse.json")),
    PayoutRouter: readJson(path.join(dir, "PayoutRouter.json")),
  };
}

/**
 * Grade observations the owner took after executing. `observed` is keyed by `<ticker>/<operation>`
 * and holds the decoded readback fields. A row with no observation is NOT-APPLIED: the whole point
 * is that a missing subject cannot grade as a pass.
 */
export function gradeReadbacks(calendar, observed) {
  const grades = [];
  for (const row of calendar.rows) {
    const key = `${row.ticker}/${row.operation}`;
    const seen = observed?.[key];
    if (seen === undefined || seen === null) {
      grades.push({ key, grade: "NOT-APPLIED", detail: "no observation recorded for this operation; an unobserved readback is not a passed one" });
      continue;
    }
    const mismatches = [];
    for (const expectation of row.readback.expect) {
      const value = seen[expectation.field];
      if (value === undefined) {
        mismatches.push(`${expectation.field} is absent from the observation`);
        continue;
      }
      if (!sameValue(value, expectation.equals)) {
        mismatches.push(`${expectation.field} is ${JSON.stringify(value)}, expected ${JSON.stringify(expectation.equals)}`);
      }
    }
    grades.push(
      mismatches.length === 0
        ? { key, grade: "APPLIED", detail: row.readback.expect.map((e) => `${e.field}=${JSON.stringify(e.equals)}`).join(" ") }
        : { key, grade: "MISMATCH", detail: mismatches.join("; ") },
    );
  }
  return grades;
}

function sameValue(a, b) {
  if (typeof a === "string" || typeof b === "string") return String(a) === String(b);
  return a === b;
}

/** The cast command that takes a readback. Printed, never run: this module makes no network calls. */
export function readbackCommand(row, addresses) {
  const address = addresses[row.readback.contract] ?? `<${row.readback.contract} address UNSET in the registry>`;
  const rpc = addresses.rpc ? ` --rpc-url ${addresses.rpc}` : "";
  return `cast call ${address} "${row.readback.call}${row.readback.returns}" ${row.readback.args.join(" ")}${rpc}`;
}

/** The calldata the owner schedules. Printed for `cast calldata`; nothing here signs or sends. */
export function calldataCommand(row) {
  if (row.signature === null) return null;
  return `cast calldata "${row.signature}" ${row.args.join(" ")}`;
}

export function renderText(calendar) {
  const lines = [];
  const iso = (s) => (s === null ? "UNKNOWN" : secondsToIso(s));
  lines.push(`# OWN8-06 listing calendar`);
  lines.push(
    calendar.generatedFrom.source === "launchSet"
      ? `generated from the registry's launchSet: ${calendar.counts.markets} markets`
      : `generated for waves ${calendar.generatedFrom.waves.join(", ")}: ${calendar.counts.markets} markets counted from the registry`,
  );
  lines.push(`start ${iso(calendar.startS)} · earliest launch ${iso(calendar.earliestLaunchS)} · target launch ${iso(calendar.targetLaunchS)}`);
  if (calendar.counts.flagged > 0) {
    // Without this line the header reads like a launch date. It is the earliest instant at which the
    // rows that ARE on the calendar could have executed, and the flagged ones are not on it at all.
    lines.push(
      `  ^ computed from the ${calendar.counts.scheduled} SCHEDULED rows only. ${calendar.counts.flagged} rows are flagged and carry no time at all, so this is not a launch date until they are resolved.`,
    );
  }
  lines.push(
    calendar.expirationS === null
      ? `execution window END is UNKNOWN: pass --expiration-s from the manager's own readback (cast call <AccessManager> "expiration()(uint32)"). A scheduled operation EXPIRES after it, and an expired one must be scheduled again.`
      : `execution window: earliest .. earliest + ${calendar.expirationS}s (AccessManager.expiration())`,
  );
  lines.push(
    calendar.evidence === null
      ? `route evidence: NONE SUPPLIED - every routed market is flagged, not scheduled`
      : `route evidence: ${calendar.evidence.pools} pools measured at ${calendar.evidence.measuredAt} (block ${calendar.evidence.block ?? "?"})`,
  );
  lines.push("");

  for (const row of calendar.rows) {
    const head = `${row.status.toUpperCase().padEnd(9)} ${row.ticker.padEnd(6)} ${row.operation}`;
    if (row.status === "scheduled") {
      lines.push(
        `${head} role ${row.role} delay ${row.delayS}s (${(row.delayS / 3600).toFixed(row.delayS % 3600 === 0 ? 0 : 2)} h)` +
          `${row.tooLate ? "  ** TOO LATE FOR THE TARGET LAUNCH **" : ""}`,
      );
      lines.push(`          schedule at ${iso(row.scheduleAtS)} -> earliest execute ${iso(row.earliestExecuteAtS)}${row.expiresAtS === null ? "" : ` -> expires ${iso(row.expiresAtS)}`}`);
      if (row.scheduleByS !== null) lines.push(`          to make the target launch, schedule by ${iso(row.scheduleByS)}`);
      lines.push(`          ${calldataCommand(row)}`);
    } else {
      lines.push(`${head} ${row.reason}`);
    }
    lines.push(`          readback ${readbackCommand(row, calendar.addresses)}`);
    lines.push(`          expect   ${row.readback.expect.map((e) => `${e.field}=${JSON.stringify(e.equals)} (field ${e.index})`).join(", ")}`);
    lines.push(`          FAILS if ${row.readback.failsWhen}`);
    lines.push("");
  }

  lines.push(
    `counts: scheduled ${calendar.counts.scheduled} · flagged ${calendar.counts.flagged} · in-kind ${calendar.counts.inKind} · too late ${calendar.counts.tooLate} · rows whose target address is unset in the registry ${calendar.counts.addressUnset}`,
  );
  return lines.join("\n");
}

export const USAGE = `ops/v8/listing-calendar.mjs — OWN8-06 registration and route calendar (read-only; makes no network calls)

  --registry <file>          default ops/markets/tier1.json
  --roles <file>             default ops/abis/v2/roles.json
  --routes-evidence <file>   fresh v4 pool measurement; without it every routed market is FLAGGED
  --wave <name>              repeatable; default ${LAUNCH_WAVES.join(" ")}
  --start <iso>              when the owner starts scheduling; default now
  --launch-at <iso>          the intended launch instant; rows that can no longer make it are flagged TOO LATE
  --expiration-s <n>         AccessManager.expiration(); without it the window END prints UNKNOWN
  --max-evidence-age-s <n>   default ${DEFAULT_MAX_EVIDENCE_AGE_S}
  --verify <file>            grade observed readbacks: {"<ticker>/<operation>": {"enabled": true, ...}}
  --format text|json         default text
  --allow-unset-addresses    plan against a registry whose v8 addresses are still null (pre-deploy rehearsal)

exit 0 nothing flagged · exit 2 a flagged row, a too-late row, or an unset target address · exit 1 usage`;

export function parseArgs(argv) {
  const out = { waves: [], format: "text", allowUnsetAddresses: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--registry": out.registry = need(i, flag); i += 1; break;
      case "--roles": out.roles = need(i, flag); i += 1; break;
      case "--routes-evidence": out.evidence = need(i, flag); i += 1; break;
      case "--wave": out.waves.push(need(i, flag)); i += 1; break;
      case "--start": out.start = need(i, flag); i += 1; break;
      case "--launch-at": out.launchAt = need(i, flag); i += 1; break;
      case "--expiration-s": out.expirationS = Number(need(i, flag)); i += 1; break;
      case "--max-evidence-age-s": out.maxEvidenceAgeS = Number(need(i, flag)); i += 1; break;
      case "--verify": out.verify = need(i, flag); i += 1; break;
      case "--format": out.format = need(i, flag); i += 1; break;
      case "--allow-unset-addresses": out.allowUnsetAddresses = true; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new UsageError(`unknown flag ${flag}`);
    }
  }
  if (out.format !== "text" && out.format !== "json") throw new UsageError(`--format must be text or json`);
  if (out.expirationS !== undefined && !Number.isInteger(out.expirationS)) throw new UsageError("--expiration-s must be an integer");
  if (out.maxEvidenceAgeS !== undefined && !Number.isInteger(out.maxEvidenceAgeS)) throw new UsageError("--max-evidence-age-s must be an integer");
  return out;
}

export function run(argv, { now = Date.now() } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, text: USAGE };

  const registry = readJson(args.registry ?? DEFAULT_REGISTRY);
  const roles = readJson(args.roles ?? DEFAULT_ROLES);
  const evidence = args.evidence ? readJson(args.evidence) : null;

  if (evidence !== null && dig(registry, "shared.chainId") !== null && evidence.chainId !== undefined && evidence.chainId !== dig(registry, "shared.chainId")) {
    throw new UsageError(`route evidence chainId ${evidence.chainId} is not the registry's ${dig(registry, "shared.chainId")}`);
  }

  const calendar = buildCalendar({
    registry,
    roles,
    evidence,
    // No --wave means the registry's launchSet, not a wave filter. See {launchMarkets}.
    waves: args.waves.length > 0 ? args.waves : null,
    startS: args.start ? isoToSeconds(args.start, "--start") : Math.floor(now / 1000),
    launchAtS: args.launchAt ? isoToSeconds(args.launchAt, "--launch-at") : null,
    expirationS: args.expirationS ?? null,
    maxEvidenceAgeS: args.maxEvidenceAgeS ?? DEFAULT_MAX_EVIDENCE_AGE_S,
  });

  let code = 0;
  if (calendar.counts.flagged > 0 || calendar.counts.tooLate > 0) code = 2;
  if (calendar.counts.addressUnset > 0 && !args.allowUnsetAddresses) code = 2;

  let grades = null;
  if (args.verify) {
    grades = gradeReadbacks(calendar, readJson(args.verify));
    if (grades.some((g) => g.grade !== "APPLIED")) code = 2;
  }

  if (args.format === "json") {
    return { code, text: JSON.stringify({ calendar, grades }, null, 2) };
  }

  const text = [
    renderText(calendar),
    ...(calendar.counts.addressUnset > 0
      ? [
          "",
          `NOT EXECUTABLE: ${calendar.counts.addressUnset} rows point at a contract address the registry still publishes as null. The calendar is a rehearsal until OWN8-03's write-back fills v2.contracts (--allow-unset-addresses to plan anyway).`,
        ]
      : []),
    ...(grades === null ? [] : ["", "# readback grades", ...grades.map((g) => `${g.grade.padEnd(12)} ${g.key}  ${g.detail}`)]),
  ].join("\n");
  return { code, text };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { code, text } = run(process.argv.slice(2));
    console.log(text);
    process.exit(code);
  } catch (error) {
    console.error(error instanceof UsageError ? `usage: ${error.message}` : error);
    process.exit(1);
  }
}
