/**
 * OWN8-08: enable the buyback at the 50 USDG cap, then prove the first burn was INDEXED.
 *
 * "Enabled" and "working" are different facts and the gap between them is where this goes wrong: the cap can be
 * set, the executor can be wired, and no burn ever appears because the splitter holds nothing, the pool has no
 * liquidity, or the indexer is not watching the splitter at all. So this file checks both, and the burn watch
 * fails on SILENCE - a window that elapses with no indexed burn exits non-zero, and a /v2/flywheel response
 * that cannot show a burn at all (configured:false, or the field missing) exits UNPROVEN rather than OK.
 *
 * This file NEVER submits a transaction. `--execute` means "perform the live READ-ONLY verification". The
 * owner sets the cap from the Admin Safe, following ops/runbooks/v8-makervault.md.
 *
 *   node ops/v8/buyback-enable.mjs                                       # dry run: plan only, no RPC, no HTTP
 *   node ops/v8/buyback-enable.mjs --usdg-decimals 6                     # dry run WITH the setBuybackCap calldata
 *   node ops/v8/buyback-enable.mjs --execute --chain-id 4663             # live readback of the cap and executor
 *   node ops/v8/buyback-enable.mjs --execute --chain-id 4663 --watch-burn --window-seconds 1800
 *
 * The RPC URL comes from RH_RPC and the indexer base URL from V2_INDEXER_URL; neither is accepted in argv,
 * because production endpoints embed credentials.
 *
 * Sources, mirrored not re-reasoned:
 *   - `setBuybackCap(uint256)`, `buybackCap()`, `executor()`, `paused()`, `Burned(uint256)`:
 *     ops/abis/v2/FeeSplitter.json, which this file READS at run time instead of retyping a signature.
 *   - The 50 USDG figure: v8-plan/tasks/OWN-owner.md OWN8-08 ("Enable buyback at the 50 USDG cap").
 *   - USDG decimals are NEVER assumed. Offline you pass --usdg-decimals and the live run refuses if the chain
 *     disagrees; without it the dry run withholds the calldata rather than guessing a scale.
 *   - The burn evidence: the indexer's /v2/flywheel route (indexer/src/api/v2/flywheel.ts:44-110), whose
 *     `burnedTotal` is null when the splitter is not configured and "0" before the first burn.
 *
 * Exit codes: 0 verified; 1 refused, or a readback that ran and did not match, or a window that elapsed with no
 * burn; 2 unexpected error; 3 a check that could not see its subject (see the printed UNPROVEN line).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, Refusal, Unproven, governingRole, loadViem, readRegistry, resolveAddress } from "./makervault-canary.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const DEFAULT_REGISTRY = path.join(REPO, "ops", "markets", "tier1.json");
export const FEE_SPLITTER_ABI_PATH = path.join(REPO, "ops", "abis", "v2", "FeeSplitter.json");

/** OWN8-08's figure, in whole USDG. The base-unit value is this scaled by decimals READ from chain. */
export const CAP_USDG = 50n;
/** The roles.json key for the call this task plans. */
export const SET_BUYBACK_CAP_SIGNATURE = "setBuybackCap(uint256)";
/** How long the first-burn watch waits before calling silence a failure. */
export const DEFAULT_WINDOW_SECONDS = 1800;
export const DEFAULT_POLL_SECONDS = 20;

export { EXIT, Refusal, Unproven };

const lc = (value) => String(value).toLowerCase();

/**
 * The FeeSplitter ABI, loaded from the artifact rather than typed here. A missing or malformed artifact is a
 * REFUSAL: a script that silently falls back to a hand-written fragment is how a wrong selector ships.
 */
export function loadFeeSplitterAbi(filename = FEE_SPLITTER_ABI_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Refusal(`FeeSplitter ABI: cannot read ${filename}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  const abi = Array.isArray(parsed) ? parsed : parsed?.abi;
  if (!Array.isArray(abi)) throw new Refusal(`FeeSplitter ABI: ${filename} does not contain an ABI array`);
  for (const name of ["setBuybackCap", "buybackCap", "executor", "paused"]) {
    if (!abi.some((e) => e.type === "function" && e.name === name)) {
      throw new Refusal(`FeeSplitter ABI: ${filename} has no ${name}() - the artifact does not match the contract this task was written against`);
    }
  }
  return abi;
}

export function resolveTargets(registry) {
  const chainId = registry?.shared?.chainId;
  if (!Number.isInteger(chainId)) throw new Refusal("registry: shared.chainId is not an integer");
  return {
    chainId,
    feeSplitter: resolveAddress(registry, {
      label: "FeeSplitter",
      key: "v2.flywheel.feeSplitter",
      mirrorKey: "v2.protocolAddresses.feeSplitter",
    }),
    buybackExecutor: resolveAddress(registry, {
      label: "buyback executor",
      key: "v2.flywheel.buybackExecutor",
      mirrorKey: "v2.protocolAddresses.buybackExecutor",
    }),
    usdg: resolveAddress(registry, { label: "USDG", key: "shared.usdg" }),
    adminSafe: resolveAddress(registry, { label: "Admin Safe", key: "shared.safes.admin" }),
  };
}

export function capBaseUnits(capUsdg, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Refusal(`USDG decimals are unknown (${String(decimals)}): the cap cannot be expressed in base units. Pass --usdg-decimals for an offline plan, or run --execute to read them from chain.`);
  }
  return BigInt(capUsdg) * 10n ** BigInt(decimals);
}

export function capCalldata({ capUsdg, decimals, abi = loadFeeSplitterAbi(), viem = loadViem() }) {
  return viem.encodeFunctionData({ abi, functionName: "setBuybackCap", args: [capBaseUnits(capUsdg, decimals)] });
}

/**
 * The live, READ-ONLY readback of the enable. Every leg must SEE its subject: no code at the splitter is
 * UNPROVEN, not a pass, and an executor of zero fails rather than reading as "not configured yet".
 */
export async function verifyEnable({ client, feeSplitter, expectedCapBaseUnits, expectedExecutor, expectedChainId }) {
  const chainId = await client.getChainId();
  if (Number(chainId) !== Number(expectedChainId)) {
    throw new Refusal(`chain id: RH_RPC is chain ${chainId}, --chain-id said ${expectedChainId}`);
  }
  const code = await client.getCode({ address: feeSplitter });
  if (code === undefined || code === null || code === "0x" || code === "") {
    throw new Unproven(`no code at FeeSplitter ${feeSplitter} on chain ${chainId}: the cap readback has no subject, so it proves nothing`);
  }
  const read = async (functionName) => {
    try {
      return await client.readContract({ address: feeSplitter, functionName, args: [] });
    } catch (error) {
      throw new Unproven(`${functionName}() reverted or could not be decoded at ${feeSplitter}: ${String(error?.shortMessage ?? error?.message ?? error).split("\n")[0]}`);
    }
  };
  const [cap, executor, paused] = await Promise.all([read("buybackCap"), read("executor"), read("paused")]);
  const findings = [];
  if (cap === undefined || cap === null) findings.push({ check: "buybackCap", expected: String(expectedCapBaseUnits), observed: "ABSENT" });
  else if (BigInt(cap) !== BigInt(expectedCapBaseUnits)) findings.push({ check: "buybackCap", expected: String(expectedCapBaseUnits), observed: String(cap) });
  if (typeof executor !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(executor)) {
    findings.push({ check: "executor", expected: expectedExecutor, observed: executor === undefined ? "ABSENT" : String(executor) });
  } else if (lc(executor) !== lc(expectedExecutor)) {
    findings.push({ check: "executor", expected: expectedExecutor, observed: executor });
  }
  if (paused !== false) {
    findings.push({ check: "paused", expected: "false", observed: paused === undefined ? "ABSENT" : String(paused) });
  }
  return { chainId: Number(chainId), cap, executor, paused, findings, ok: findings.length === 0 };
}

/**
 * One reading of the indexer's burn total. Returns a verdict, never a bare number, because there are three
 * distinct answers and only one of them is "no burn yet":
 *   blind   - the route cannot show a burn at all (not configured, or the field is gone). Proves nothing.
 *   waiting - the route is watching and the total is still zero.
 *   burned  - a burn is indexed.
 */
export function classifyFlywheel(body) {
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
    return { state: "blind", why: `/v2/flywheel returned ${Array.isArray(body) ? "an array" : String(body)}, not an object` };
  }
  if (!Object.prototype.hasOwnProperty.call(body, "burnedTotal")) {
    return { state: "blind", why: "/v2/flywheel has no burnedTotal field: this watch cannot see its subject (route or schema changed)" };
  }
  if (body.configured === false) {
    return { state: "blind", why: "/v2/flywheel reports configured:false - the indexer has no FeeSplitter address, so a burn could never appear here" };
  }
  if (body.burnedTotal === null) {
    return { state: "blind", why: "/v2/flywheel burnedTotal is null - the route is not projecting burns" };
  }
  let total;
  try {
    total = BigInt(body.burnedTotal);
  } catch {
    return { state: "blind", why: `/v2/flywheel burnedTotal is not an integer string: ${JSON.stringify(body.burnedTotal)}` };
  }
  if (total > 0n) return { state: "burned", total, lastDistribution: body.lastDistribution ?? null };
  return { state: "waiting", total };
}

/**
 * Poll until a burn is indexed. Silence is a FAILURE, not a pass: the window elapsing returns ok:false, and a
 * route that cannot see burns returns blind, which the caller turns into UNPROVEN.
 */
export async function watchFirstBurn({
  fetchJson,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  pollSeconds = DEFAULT_POLL_SECONDS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const deadline = now() + windowSeconds * 1000;
  let polls = 0;
  let lastWaiting = null;
  for (;;) {
    polls += 1;
    let body;
    try {
      body = await fetchJson();
    } catch (error) {
      return { ok: false, state: "blind", polls, why: `/v2/flywheel could not be read: ${String(error?.message ?? error).split("\n")[0]}` };
    }
    const verdict = classifyFlywheel(body);
    if (verdict.state === "blind") return { ok: false, state: "blind", polls, why: verdict.why };
    if (verdict.state === "burned") {
      return { ok: true, state: "burned", polls, total: verdict.total, lastDistribution: verdict.lastDistribution };
    }
    lastWaiting = verdict.total;
    log(`  poll ${polls}: burnedTotal=${verdict.total}, still waiting`);
    if (now() >= deadline) {
      return {
        ok: false,
        state: "silent",
        polls,
        total: lastWaiting,
        why: `no burn indexed within ${windowSeconds}s. Enabled is not working: check the splitter's USDG balance, the executor's pool liquidity, and whether the cranker is calling buyback().`,
      };
    }
    await sleep(pollSeconds * 1000);
  }
}

export function flywheelUrl(base) {
  if (typeof base !== "string" || base.length === 0) {
    throw new Refusal("V2_INDEXER_URL is not set: the indexer base URL comes from the environment, never argv");
  }
  return `${base.replace(/\/+$/, "")}/v2/flywheel`;
}

export function parseArgs(argv) {
  const opts = {
    registry: DEFAULT_REGISTRY,
    execute: false,
    chainId: null,
    capUsdg: CAP_USDG,
    usdgDecimals: null,
    watchBurn: false,
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    pollSeconds: DEFAULT_POLL_SECONDS,
    rpcEnv: "RH_RPC",
    indexerEnv: "V2_INDEXER_URL",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Refusal(`${arg}: missing value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--registry": opts.registry = next(); break;
      case "--execute": case "--check": opts.execute = true; break;
      case "--chain-id": opts.chainId = Number(next()); break;
      case "--cap-usdg": opts.capUsdg = BigInt(next()); break;
      case "--usdg-decimals": opts.usdgDecimals = Number(next()); break;
      case "--watch-burn": opts.watchBurn = true; break;
      case "--window-seconds": opts.windowSeconds = Number(next()); break;
      case "--poll-seconds": opts.pollSeconds = Number(next()); break;
      case "--rpc-env": opts.rpcEnv = next(); break;
      case "--indexer-env": opts.indexerEnv = next(); break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Refusal(`unknown argument ${arg}`);
    }
  }
  if (opts.execute && !Number.isInteger(opts.chainId)) {
    throw new Refusal("--execute requires --chain-id <id>: a live readback against an unnamed chain proves nothing");
  }
  if (opts.watchBurn && !opts.execute) {
    throw new Refusal("--watch-burn without --execute: the burn watch only runs after the cap readback has passed");
  }
  if (!(opts.windowSeconds > 0) || !(opts.pollSeconds > 0)) throw new Refusal("--window-seconds and --poll-seconds must be positive");
  return opts;
}

const USAGE = `ops/v8/buyback-enable.mjs - OWN8-08 enable the buyback and prove the first indexed burn

  --registry <path>      registry to read (default ops/markets/tier1.json)
  --cap-usdg <n>         whole USDG cap (default ${CAP_USDG}, the OWN8-08 figure)
  --usdg-decimals <n>    decimals for the OFFLINE calldata; the live run refuses if the chain disagrees
  --execute              perform the live READ-ONLY readback (requires --chain-id). Never sends a transaction.
  --chain-id <id>        the chain RH_RPC must be on
  --watch-burn           after the readback passes, poll /v2/flywheel until a burn is indexed
  --window-seconds <n>   how long silence is tolerated before it is a failure (default ${DEFAULT_WINDOW_SECONDS})
  --poll-seconds <n>     poll interval (default ${DEFAULT_POLL_SECONDS})

Exit: 0 verified, 1 refused / mismatched / silent window, 2 error, 3 a check could not see its subject.`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const registry = readRegistry(opts.registry);
  const targets = resolveTargets(registry);
  const abi = loadFeeSplitterAbi();

  console.log("Buyback enable (OWN8-08)");
  console.log(`  registry         ${opts.registry}`);
  console.log(`  chain            ${targets.chainId}`);
  console.log(`  FeeSplitter      ${targets.feeSplitter}`);
  console.log(`  buyback executor ${targets.buybackExecutor}`);
  console.log(`  USDG             ${targets.usdg}`);
  console.log(`  Admin Safe       ${targets.adminSafe}  (schedules, waits, then sends setBuybackCap)`);
  console.log(`  cap              ${opts.capUsdg} USDG`);

  let decimals = opts.usdgDecimals;
  const viem = loadViem();
  const client = opts.execute
    ? viem.createPublicClient({ transport: viem.http(env[opts.rpcEnv] ?? "", { timeout: 30_000, retryCount: 1 }) })
    : null;

  if (opts.execute) {
    if (!env[opts.rpcEnv]) throw new Refusal(`${opts.rpcEnv} is not set: the RPC URL comes from the environment, never argv`);
    const usdgAbi = viem.parseAbi(["function decimals() view returns (uint8)"]);
    const code = await client.getCode({ address: targets.usdg });
    if (code === undefined || code === null || code === "0x" || code === "") {
      throw new Unproven(`no code at USDG ${targets.usdg}: decimals cannot be read, so the cap cannot be checked in base units`);
    }
    const onChain = Number(await client.readContract({ address: targets.usdg, abi: usdgAbi, functionName: "decimals", args: [] }));
    if (decimals !== null && decimals !== onChain) {
      throw new Refusal(`--usdg-decimals ${decimals} disagrees with USDG.decimals() = ${onChain} on chain. Do not scale a cap by a guess.`);
    }
    decimals = onChain;
  }

  if (decimals === null) {
    console.log("\nstep 1 - setBuybackCap calldata: WITHHELD. USDG decimals are unknown offline; pass --usdg-decimals <n> or run --execute.");
  } else {
    const base = capBaseUnits(opts.capUsdg, decimals);
    const governs = governingRole({ target: "FeeSplitter", signature: SET_BUYBACK_CAP_SIGNATURE });
    console.log(`\nstep 1 - setBuybackCap is ${governs.role} (role id ${governs.roleId}) with a ${governs.delaySeconds}s execution delay (ops/abis/v2/roles.json).`);
    if (governs.delaySeconds > 0) {
      console.log(`  The Admin Safe SCHEDULES this on the AccessManager, waits ${governs.delaySeconds}s, then sends it to the target directly (ops/runbooks/v8-roles.md).`);
    }
    console.log(`  cap ${base} base units at ${decimals} decimals`);
    console.log(`  to   ${targets.feeSplitter}`);
    console.log(`  data ${capCalldata({ capUsdg: opts.capUsdg, decimals, abi, viem })}`);
  }

  if (!opts.execute) {
    console.log("\nstep 2 - readback: NOT RUN (dry run).");
    console.log("step 3 - first-burn watch: NOT RUN. Silence here would be a failure, not a pass.");
    return EXIT.OK;
  }

  const splitterAbi = viem.parseAbi([
    "function buybackCap() view returns (uint256)",
    "function executor() view returns (address)",
    "function paused() view returns (bool)",
  ]);
  const splitterClient = {
    getChainId: () => client.getChainId(),
    getCode: (a) => client.getCode(a),
    readContract: (a) => client.readContract({ ...a, abi: splitterAbi }),
  };
  const expectedCap = capBaseUnits(opts.capUsdg, decimals);
  const enable = await verifyEnable({
    client: splitterClient,
    feeSplitter: targets.feeSplitter,
    expectedCapBaseUnits: expectedCap,
    expectedExecutor: targets.buybackExecutor,
    expectedChainId: opts.chainId,
  });
  console.log(`\nstep 2 - readback at ${targets.feeSplitter} on chain ${enable.chainId}:`);
  console.log(`  buybackCap ${String(enable.cap)}  (expected ${expectedCap})`);
  console.log(`  executor   ${String(enable.executor)}  (expected ${targets.buybackExecutor})`);
  console.log(`  paused     ${String(enable.paused)}  (expected false)`);
  if (!enable.ok) {
    console.log("\nFAILED - the buyback is not enabled as specified:");
    for (const f of enable.findings) console.log(`  ${f.check}: expected ${f.expected}, chain says ${f.observed}`);
    console.log("step 3 - first-burn watch: NOT RUN (the enable did not verify).");
    return EXIT.REFUSED;
  }
  console.log("  VERIFIED - cap, executor and unpaused all match.");

  if (!opts.watchBurn) {
    console.log("\nstep 3 - first-burn watch: not requested. 'Enabled' is not 'working'; re-run with --watch-burn.");
    return EXIT.OK;
  }
  const url = flywheelUrl(env[opts.indexerEnv]);
  console.log(`\nstep 3 - first-burn watch against ${url}, window ${opts.windowSeconds}s:`);
  const watch = await watchFirstBurn({
    fetchJson: async () => {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    windowSeconds: opts.windowSeconds,
    pollSeconds: opts.pollSeconds,
    log: (line) => console.log(line),
  });
  if (watch.ok) {
    console.log(`  BURNED - burnedTotal=${watch.total} after ${watch.polls} poll(s). The flywheel is indexed, not just enabled.`);
    return EXIT.OK;
  }
  if (watch.state === "blind") {
    console.log(`  UNPROVEN - ${watch.why}`);
    return EXIT.UNPROVEN;
  }
  console.log(`  FAILED - ${watch.why}`);
  return EXIT.REFUSED;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof Refusal) {
        console.error(`REFUSED: ${error.message}`);
        process.exit(EXIT.REFUSED);
      }
      if (error instanceof Unproven) {
        console.error(`UNPROVEN: ${error.message}`);
        process.exit(EXIT.UNPROVEN);
      }
      console.error(error);
      process.exit(EXIT.ERROR);
    });
}
