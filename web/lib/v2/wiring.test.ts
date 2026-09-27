/**
 * THE APP SENDS NO WRITE A USER MAY NOT CALL.
 *
 * The House vault page shipped a Claim button (houseTx.ts claimHouseOwed) that calls HouseVault.claimOwed(), which the
 * role manifest gives to QUOTER: every click reverted for every user. Nothing checked the app's writes against
 * the manifest. This file does, and it derives both sides instead of listing them:
 *
 *   THE WRITES are read out of the source with the TypeScript parser. A write is a call to one of viem's write entry
 *   points (VIEM_SINKS) or to an app function that forwards its own `abi` and `functionName` parameters into one (a
 *   "wrapper", found by the same scan: simulatedWrite in tx.ts, the local `write` helpers in earnTx/lendTx/zapTx, and any
 *   the next file adds). At every call site the ABI argument is followed through its import to a generated ABI module
 *   under lib/abi/, and the function name must be a string literal (or a const / conditional of them). The function's
 *   own stateMutability in that ABI says whether it is a write, so reads through the same entry points drop out.
 *   A site whose ABI or function name cannot be resolved FAILS the first test: an unresolvable write is exactly the kind
 *   this guard cannot judge, so it is never skipped.
 *
 *   THE RULES are ops/abis/v2/roles.json, the manifest the contracts' AccessManager is configured from (generated from
 *   callhouse-contracts script/v2/roles.v8.json). A (contract, signature) listed under `targets` has a manager role, so a
 *   plain wallet cannot call it. The contract name comes from the ABI module's GENERATED header ("from
 *   ops/abis/v2/<Name>.json"), which is the manifest's own key. A manifest target with NO ABI of its own under
 *   ops/abis/v2 is a second deployment of the contract whose name prefixes it (RewardsDistributorLender is a
 *   RewardsDistributor), so that ABI is judged against it too; a target with its own ABI (HouseVaultFactory beside
 *   HouseVault) is a different contract and never inherits.
 *
 * VIEM_SINKS names viem's API, not the app's: a new button reaches the chain through one of these whatever it is called.
 * ADMIN_WRITES is the hand-written list for writes deliberately gated to an admin surface, each with its reason. It is
 * empty: the app has no admin UI.
 *
 * THE LEGACY WRITES have no manifest: the v1 vault, WriterAccount and AccountFactory,
 * Valorem, Seaport and the Uniswap periphery the stock swap uses are not AccessManaged v8 contracts, so
 * roles.json says nothing about them. They are judged against LEGACY_WRITES instead, a closed table keyed by
 * `<ABI export>.<signature>` that names, for each, the access check its DEPLOYED source puts on the function and cites
 * the declaration line as repo@SHA:file:line. Three cases close it: a scanned legacy write with no entry fails, an entry
 * whose check a plain wallet cannot pass on its own position fails, and an entry no scanned write matches fails.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { erc20Abi as viemErc20Abi, toFunctionSignature, type Abi, type AbiFunction } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(WEB, "..");
const SOURCE_ROOTS = ["lib", "components", "app", "hooks"];
const ABI_ROOT = join(WEB, "lib/abi");

/**
 * viem's and wagmi's write entry points. The object form carries `abi` and `functionName` properties. The raw
 * `sendTransaction*` calls carry neither, so any the app makes is reported as unresolved rather than passed.
 */
const VIEM_SINKS = new Set([
  "simulateContract", "writeContract", "writeContractAsync", "encodeFunctionData", "estimateContractGas",
  "sendTransaction", "sendTransactionAsync",
]);

/** (contract.signature) -> why an admin surface may send it. Empty: the app has no admin UI. */
const ADMIN_WRITES: Readonly<Record<string, string>> = {};

/**
 * How a legacy function decides who may call it, in the deployed source.
 *   open           no caller check at all (state gates such as a phase or a deadline are not access checks);
 *   own-position   acts only on msg.sender's own balance, shares, options, orders or owed amount;
 *   account-owner  onlyOwner on a WriterAccount, whose owner is the wallet that called AccountFactory.createAccount
 *                  (V1_SOLO:src/solo/AccountFactory.sol:111-116 initialize(msg.sender, …);
 *                  Account.sol:154-159 sets it, :125-128 checks it), and the app targets accountOf(connected wallet)
 *                  (components/AccountView.tsx, components/legacy/MigrationGuide.tsx), so it is always the sender's own;
 *   role           a role or manager a plain wallet does not hold. No legacy write the app sends is one.
 */
type LegacyAccess = { kind: "open" | "own-position" | "account-owner" | "role"; check: string };
const PLAIN_WALLET_PASSES: ReadonlySet<LegacyAccess["kind"]> = new Set(["open", "own-position", "account-owner"]);

/**
 * THE DEPLOYED SOURCE EACH GROUP IS JUDGED AGAINST, and why (re-derived, not taken from notes):
 *   (v7 run-off: its five writes left the app with the change that removed lib/v7/tx.ts; case (c) below is what
 *                made their entries go. They were own-position exits in the v7 contracts.)
 *   v1 vault     V1_VAULT (tag v1.0.0-rc1): broadcast/Deploy.s.sol/4663/run-1789456024807.json records that commit
 *                for Vault 0x88a9…4ecbb, and the Sourcify-verified Vault.sol / Distributor.sol blobs equal V1_VAULT's.
 *                A later commit differs by one arithmetic line and a comment, neither an access check.
 *   v1 solo      V1_SOLO: the Sourcify-verified Account.sol / AccountFactory.sol equal V1_SOLO's, and the deploy
 *                input carries selectors only V1_SOLO has; its record names another commit, whose tree was dirty. The later commit's
 *                Account.sol adds post-deploy code, so its line numbers are not the deployed ones.
 *   Valorem      valorem-core 6436c823: the live Clear at contracts.ts CLEARINGHOUSE is byte-identical to
 *                V1_VAULT's script/artifacts/ValoremOptionsClearinghouse.json, whose source hash is
 *                that file's.
 *   Seaport 1.6  seaport tag 1.6 (e9c5a9f1), core submodule seaport-core 1a0a4758; the zone hooks (Vault.sol:1232-1239,
 *                Account.sol:267-274) check the order, never the fulfiller.
 *   Uniswap      the 4663 UniversalRouter's verified UniversalRouter.sol equals universal-router 8c79e619's; Permit2's
 *                4663 code equals mainnet's except its two EIP-712 immutables (upstream permit2 cc56ad0f); the QuoterV2
 *                at 0x33e8…A9E7 is a third-party deployment of v3-periphery 7c987c2a's file (plus a banner comment).
 */
const V1_VAULT = "callhouse-contracts@165b4abb2eda2a9b44520654ddac6a59f164c386";
const V1_SOLO = "callhouse-contracts@5eb84d1b93910d43573cf13f701e6a112f072634";
const SEAPORT_ADVANCED_ORDER =
  "((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes)";

/** Every legacy write the app sends, judged. Keyed `<ABI export>.<signature>`; closed both ways. */
const LEGACY_WRITES: Readonly<Record<string, { access: LegacyAccess; source: string }>> = {
  // Uniswap periphery, the stock swap (lib/v2/stockSwap.ts).
  "quoterV3Abi.quoteExactInput(bytes,uint256)": { access: { kind: "open", check: "none; nonpayable but the app only simulates it for a quote" },
    source: "Uniswap/v3-periphery@7c987c2a5131193d36d51001b1b04be907b0ba06:contracts/lens/QuoterV2.sol:153" },
  "universalRouterAbi.execute(bytes,bytes[],uint256)": { access: { kind: "open", check: "none; checkDeadline and a reentrancy lock, and it spends only the caller's Permit2 allowance" },
    source: "Uniswap/universal-router@8c79e6194284996ced266b4f7ee8cbbe75f65787:contracts/UniversalRouter.sol:40" },
  "permit2Abi.approve(address,address,uint160,uint48)": { access: { kind: "own-position", check: "writes allowance[msg.sender][token][spender]" },
    source: "Uniswap/permit2@cc56ad0f3439c502c246fc5cfcc3db92bb8b7219:src/AllowanceTransfer.sol:26" },
  // v1 solo writer accounts (components/AccountView.tsx, components/legacy/MigrationGuide.tsx).
  "accountFactoryAbi.createAccount()": { access: { kind: "open", check: "none; one account per msg.sender, owned by it" },
    source: `${V1_SOLO}:src/solo/AccountFactory.sol:111` },
  "writerAccountAbi.deposit(uint256)": { access: { kind: "account-owner", check: "onlyOwner" }, source: `${V1_SOLO}:src/solo/Account.sol:172` },
  "writerAccountAbi.withdraw(uint256)": { access: { kind: "account-owner", check: "onlyOwner; pays the owner" }, source: `${V1_SOLO}:src/solo/Account.sol:185` },
  "writerAccountAbi.requestWrite(uint64)": { access: { kind: "account-owner", check: "onlyOwner" }, source: `${V1_SOLO}:src/solo/Account.sol:192` },
  "writerAccountAbi.list()": { access: { kind: "account-owner", check: "owner, the factory, or a factory KEEPER_ROLE holder (:203-206); the app sends it as the owner" },
    source: `${V1_SOLO}:src/solo/Account.sol:202` },
  "writerAccountAbi.settle()": { access: { kind: "open", check: "none; a TooEarly state gate only" }, source: `${V1_SOLO}:src/solo/Account.sol:328` },
  "writerAccountAbi.claimUsdg()": { access: { kind: "account-owner", check: "onlyOwner; pays the owner" }, source: `${V1_SOLO}:src/solo/Account.sol:370` },
  // Seaport 1.6 (components/BookView.tsx).
  [`seaportAbi.fulfillAdvancedOrder(${SEAPORT_ADVANCED_ORDER},(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)`]: {
    access: { kind: "open", check: "none; the buyer fills a live listing and pays from its own wallet" },
    source: "ProjectOpenSea/seaport-core@1a0a4758cced1d3de962817cd37c2387fb290eea:src/lib/Consideration.sol:235" },
  // Valorem Clear (components/legacy/ExercisePanel.tsx).
  "valoremClearAbi.exercise(uint256,uint112)": { access: { kind: "own-position", check: "balanceOf[msg.sender][optionId] >= amount; burns the caller's options" },
    source: "valorem-labs-inc/valorem-core@6436c823f560af493af119d6148fb3237037aca4:src/ValoremOptionsClearinghouse.sol:573" },
  // v1 pooled vault (components/RedeemQueue.tsx, StrandedBanner.tsx, UsdgClaim.tsx).
  "vaultAbi.redeem(uint256,address,address)": { access: { kind: "own-position", check: "ERC-4626 owner-or-allowance; the app passes owner = the sender" },
    source: `${V1_VAULT}:src/Vault.sol:763` },
  "vaultAbi.queueRedeem(uint256)": { access: { kind: "own-position", check: "queues balanceOf(msg.sender)" }, source: `${V1_VAULT}:src/Vault.sol:808` },
  "vaultAbi.completeRedeem(address)": { access: { kind: "own-position", check: "_completeRedeem(msg.sender, receiver)" }, source: `${V1_VAULT}:src/Vault.sol:844` },
  "vaultAbi.settleQueue()": { access: { kind: "open", check: "none (NatSpec: Anyone); an Idle-phase gate only" }, source: `${V1_VAULT}:src/Vault.sol:1493` },
  "vaultAbi.retryStrandedClaim()": { access: { kind: "open", check: "none (NatSpec: Anyone); an isStranded gate only" }, source: `${V1_VAULT}:src/Vault.sol:1445` },
  "vaultAbi.claimUsdg()": { access: { kind: "own-position", check: "_claimUsdg(msg.sender, msg.sender); inherited from Distributor" },
    source: `${V1_VAULT}:src/Distributor.sol:165` },
};

type Manifest = { targets: Record<string, Record<string, string>> };
const manifest = JSON.parse(readFileSync(join(REPO, "ops/abis/v2/roles.json"), "utf8")) as Manifest;

/** The manifest targets an ABI named `contract` is judged against: its own, plus ABI-less targets it prefixes. */
function manifestTargetsOf(contract: string): string[] {
  return Object.keys(manifest.targets).filter((t) =>
    t === contract || (t.startsWith(contract) && !existsSync(join(REPO, "ops/abis/v2", `${t}.json`))));
}

/* ---------------------------------------------------------------- ABI modules ---------------------------------- */

type AbiModule = { contract: string; family: "v2" | "legacy" | "token"; abi: Abi };
/** `${absolute file}#${export}` -> the ABI it exports. */
const abiModules = new Map<string, AbiModule>();

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? filesUnder(path, keep) : keep(path) ? [path] : [];
  });
}

async function loadAbiModules(): Promise<void> {
  for (const file of filesUnder(ABI_ROOT, (f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const header = readFileSync(file, "utf8").slice(0, 400);
    const v2 = /from ops\/abis\/v2\/([A-Za-z0-9]+)\.json/.exec(header);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (!name.endsWith("Abi") || !Array.isArray(value)) continue;
      abiModules.set(`${file}#${name}`, {
        contract: v2 !== null ? v2[1]! : name,
        // v2: judged against the v8 manifest. token: ERC-20 / Stock Token calls (approve, transfer) on the user's own
        // balance, outside any manager. legacy: the v1 vault / Valorem / Seaport / factory and Uniswap surfaces,
        // which the v8 manifest does not describe; judged against LEGACY_WRITES.
        family: v2 !== null ? "v2" : file.endsWith("/erc20.ts") ? "token" : "legacy",
        abi: value as Abi,
      });
    }
  }
  abiModules.set("viem#erc20Abi", { contract: "ERC20", family: "token", abi: viemErc20Abi as unknown as Abi });
}

/* ---------------------------------------------------------------- source scan ----------------------------------- */

type Parsed = { file: string; source: ts.SourceFile; imports: Map<string, { from: string; name: string }> };

function resolveModule(fromFile: string, spec: string): string | null {
  if (spec === "viem") return "viem";
  const base = spec.startsWith("@/") ? join(WEB, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(fromFile), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function parse(file: string, text: string = readFileSync(file, "utf8")): Parsed {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Map<string, { from: string; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = resolveModule(file, statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (from === null || bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) imports.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
  }
  return { file, source, imports };
}

const lineOf = (p: Parsed, node: ts.Node) => p.source.getLineAndCharacterOfPosition(node.getStart(p.source)).line + 1;
const where = (p: Parsed, node: ts.Node) => `${relative(REPO, p.file)}:${lineOf(p, node)}`;

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function enclosingFunction(node: ts.Node): FunctionLike | null {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return n;
  }
  return null;
}

/** The name a function is called by: its declaration name, or the const it is assigned to. */
function functionName(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

const paramIndex = (fn: FunctionLike | null, name: string): number =>
  fn === null ? -1 : fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);

/**
 * A wrapper: calling `${file}#${name}` writes `abi = args[abiIdx]`, `functionName = args[fnIdx]` (simulatedWrite), or,
 * for an OBJECT wrapper, forwards its whole `args[objIdx]` into a sink (BookView's `write = (args) =>
 * writeContractAsync({ ...args, chainId })`), so the object literal at its call site is the one judged.
 */
type Wrapper = { abiIdx: number; fnIdx: number } | { objIdx: number };

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

/** Which wrapper (if any) a call reaches: a local function of this file or an imported one. */
function wrapperKey(p: Parsed, call: ts.CallExpression): string | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const name = call.expression.text;
  const imported = p.imports.get(name);
  return imported !== undefined ? `${imported.from}#${imported.name}` : `${p.file}#${name}`;
}

/** `x as T`, `(x)`, `x satisfies T` -> `x`. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** The (abi, functionName) expressions a sink call carries, or null when it is not a sink. */
type SinkArgs = { abi: ts.Expression | undefined; fn: ts.Expression | undefined; forwarded: boolean; spreadOf?: string | null };

function sinkArgs(p: Parsed, call: ts.CallExpression, wrappers: Map<string, Wrapper>): SinkArgs | null {
  const key = wrapperKey(p, call);
  const wrapper = key === null ? undefined : wrappers.get(key);
  if (wrapper !== undefined && "abiIdx" in wrapper) return { abi: call.arguments[wrapper.abiIdx], fn: call.arguments[wrapper.fnIdx], forwarded: false };
  const name = calleeName(call);
  if (wrapper === undefined && (name === null || !VIEM_SINKS.has(name))) return null;
  // An argument cast away (`writeContract({ ...request, account, chain } as never)`, stockSwap.ts) is still the
  // object literal it wraps; without unwrapping, the sink read as carrying no abi/functionName and the site failed as
  // unresolved even though the simulateContract that built `request` was judged.
  const args = call.arguments.map(unwrapExpression);
  const object = wrapper !== undefined && "objIdx" in wrapper
    ? (args[wrapper.objIdx] !== undefined && ts.isObjectLiteralExpression(args[wrapper.objIdx]!) ? args[wrapper.objIdx] as ts.ObjectLiteralExpression : undefined)
    : args.find(ts.isObjectLiteralExpression);
  if (object === undefined) return { abi: undefined, fn: undefined, forwarded: false };
  let abi: ts.Expression | undefined;
  let fn: ts.Expression | undefined;
  let spread = false;
  for (const prop of object.properties) {
    if (ts.isSpreadAssignment(prop)) spread = true;
    const propName = prop.name !== undefined && ts.isIdentifier(prop.name) ? prop.name.text : null;
    const value = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
    if (propName === "abi") abi = value;
    if (propName === "functionName") fn = value;
  }
  // writeContract({ ...request, account, chain }): the request a simulateContract above already built and was judged.
  return { abi, fn, forwarded: spread && abi === undefined && fn === undefined, spreadOf: spreadIdentifier(object) };
}

/** The identifier spread into a sink's object (`{ ...args, chainId }` -> "args"), when there is exactly one. */
function spreadIdentifier(object: ts.ObjectLiteralExpression): string | null {
  const spreads = object.properties.filter(ts.isSpreadAssignment);
  return spreads.length === 1 && ts.isIdentifier(spreads[0]!.expression) ? spreads[0]!.expression.text : null;
}

/** Wrappers: functions that pass their own abi and functionName parameters to a sink. To a fixpoint. */
function deriveWrappers(files: Parsed[]): Map<string, Wrapper> {
  const wrappers = new Map<string, Wrapper>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of files) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const args = sinkArgs(p, node, wrappers);
          const fn = enclosingFunction(node);
          const name = fn === null ? null : functionName(fn);
          const key = name === null ? null : `${p.file}#${name}`;
          if (args !== null && fn !== null && key !== null && !wrappers.has(key)) {
            if (args.abi !== undefined && args.fn !== undefined && ts.isIdentifier(args.abi) && ts.isIdentifier(args.fn)) {
              const abiIdx = paramIndex(fn, args.abi.text);
              const fnIdx = paramIndex(fn, args.fn.text);
              if (abiIdx >= 0 && fnIdx >= 0) {
                wrappers.set(key, { abiIdx, fnIdx });
                changed = true;
              }
            } else if (args.forwarded && args.spreadOf !== null && args.spreadOf !== undefined && paramIndex(fn, args.spreadOf) >= 0) {
              wrappers.set(key, { objIdx: paramIndex(fn, args.spreadOf) });
              changed = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(p.source);
    }
  }
  return wrappers;
}

/** An identifier's const initializer in the same file, one level (`const abi = houseVaultAbi`). */
function constInitializer(p: Parsed, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (found === null && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(p.source);
  return found;
}

const parsedCache = new Map<string, Parsed>();
const parsedFile = (file: string): Parsed => parsedCache.get(file) ?? parsedCache.set(file, parse(file)).get(file)!;

/** An exported name followed through re-export barrels (`import { x } from "./abi/x"; export { x };`) to its ABI module. */
function abiExport(file: string, name: string, depth = 0): AbiModule | null {
  if (file === "viem") return abiModules.get(`viem#${name}`) ?? null;
  const direct = abiModules.get(`${file}#${name}`);
  if (direct !== undefined || depth > 3) return direct ?? null;
  const onward = parsedFile(file).imports.get(name);
  return onward === undefined ? null : abiExport(onward.from, onward.name, depth + 1);
}

function resolveAbi(p: Parsed, expr: ts.Expression): AbiModule | null {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e)) return null;
  const imported = p.imports.get(e.text);
  if (imported !== undefined) return abiExport(imported.from, imported.name);
  const local = abiModules.get(`${p.file}#${e.text}`);
  if (local !== undefined) return local;
  const init = constInitializer(p, e.text);
  return init === null ? null : resolveAbi(p, init);
}

function resolveNames(p: Parsed, expr: ts.Expression): string[] | null {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isConditionalExpression(e)) {
    const a = resolveNames(p, e.whenTrue);
    const b = resolveNames(p, e.whenFalse);
    return a === null || b === null ? null : [...a, ...b];
  }
  if (ts.isIdentifier(e)) {
    const init = constInitializer(p, e.text);
    if (init !== null) return resolveNames(p, init);
    // A parameter typed as a union of string literals (`functionName: "settle" | "claimUsdg" | "withdraw"`): each.
    const fn = enclosingFunction(e);
    const param = fn?.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === e.text);
    const type = param?.type;
    const literals = type === undefined ? [] : ts.isUnionTypeNode(type) ? [...type.types] : [type];
    const names = literals.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null));
    return names.length > 0 && names.every((n) => n !== null) ? (names as string[]) : null;
  }
  return null;
}

type AppWrite = { site: string; contract: string; family: AbiModule["family"]; signature: string; mutability: string; role: string | null; targets: string[] };
type Unresolved = { site: string; why: string };

/** The app's source, plus any in-memory `extra` files (a fixture) scanned with the real files' wrappers and imports. */
function scan(extra: ReadonlyArray<{ file: string; text: string }> = []): { writes: AppWrite[]; unresolved: Unresolved[]; wrappers: string[] } {
  const files = [
    ...SOURCE_ROOTS.flatMap((root) =>
      filesUnder(join(WEB, root), (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.|\.d\.ts$/.test(f) && !f.startsWith(ABI_ROOT)),
    ).map((f) => parse(f)),
    ...extra.map((x) => parse(x.file, x.text)),
  ];
  const wrappers = deriveWrappers(files);
  const writes: AppWrite[] = [];
  const unresolved: Unresolved[] = [];
  for (const p of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const args = sinkArgs(p, node, wrappers);
        if (args !== null && !args.forwarded) {
          const fnScope = enclosingFunction(node);
          const passThrough = (e: ts.Expression | undefined) => e !== undefined && ts.isIdentifier(e) && paramIndex(fnScope, e.text) >= 0;
          if (passThrough(args.abi) && passThrough(args.fn)) {
            // a wrapper's own body: judged at its call sites
          } else if (args.abi === undefined || args.fn === undefined) {
            unresolved.push({ site: where(p, node), why: `${calleeName(node)} with no abi/functionName to judge` });
          } else {
            const abi = resolveAbi(p, args.abi);
            const names = resolveNames(p, args.fn);
            if (abi === null) unresolved.push({ site: where(p, node), why: `ABI "${args.abi.getText(p.source)}" is not a generated ABI module` });
            else if (names === null) unresolved.push({ site: where(p, node), why: `function name "${args.fn.getText(p.source)}" is not a literal` });
            else {
              for (const name of names) {
                const items = abi.abi.filter((i): i is AbiFunction => i.type === "function" && i.name === name);
                if (items.length === 0) unresolved.push({ site: where(p, node), why: `${abi.contract} has no function ${name}` });
                for (const item of items) {
                  if (item.stateMutability === "view" || item.stateMutability === "pure") continue;
                  const signature = toFunctionSignature(item);
                  const targets = abi.family === "v2" ? manifestTargetsOf(abi.contract) : [];
                  const role = targets.map((t) => manifest.targets[t]![signature]).find((r) => r !== undefined) ?? null;
                  writes.push({ site: where(p, node), contract: abi.contract, family: abi.family, signature, mutability: item.stateMutability, role, targets });
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(p.source);
  }
  return { writes, unresolved, wrappers: [...wrappers.keys()].map((k) => relative(REPO, k)) };
}

/* ---------------------------------------------------------------- the tests ------------------------------------- */

let result: ReturnType<typeof scan>;
beforeAll(async () => {
  await loadAbiModules();
  result = scan();
  if (process.env.WIRING_PRINT === "1") {
    console.log(JSON.stringify({ wrappers: result.wrappers, writes: result.writes, unresolved: result.unresolved }, null, 1));
  }
});

describe("every write the app can send is a function a user may call", () => {
  it("finds the app's writes and the wrappers they go through (positive control: the scan is not blind)", () => {
    expect(abiModules.size).toBeGreaterThan(20);
    expect(result.wrappers).toContain("web/lib/v2/tx.ts#simulatedWrite");
    expect(result.writes.filter((w) => w.family === "v2").length).toBeGreaterThan(20);
  });

  it("would have caught claimHouseOwed: the older helper, scanned with the real wrappers, is QUOTER-only", () => {
    // The old houseTx.ts claimHouseOwed, verbatim, beside the real houseTx.ts so
    // its relative imports resolve. A fixture rather than the live file, so this control survives fix.
    const fixture = {
      file: join(WEB, "lib/v2/houseTx.wiring-fixture.ts"),
      text: [
        'import { houseVaultAbi } from "../abi/v2/houseVault";',
        'import { simulatedWrite, type WriteContext } from "./tx";',
        "export async function claimHouseOwed(context: WriteContext, vault: string | null | undefined): Promise<Hex> {",
        "  const address = requireHouseVaultAddress(vault);",
        '  return withHouseErrorCopy(() => simulatedWrite(context, address, houseVaultAbi, "claimOwed", []));',
        "}",
      ].join("\n"),
    };
    const caught = scan([fixture]).writes.filter((w) => w.site.startsWith("web/lib/v2/houseTx.wiring-fixture.ts"));
    expect(caught).toEqual([expect.objectContaining({ contract: "HouseVault", signature: "claimOwed()", role: "QUOTER", site: "web/lib/v2/houseTx.wiring-fixture.ts:5" })]);
  });

  it("every write site resolves to a generated ABI and a literal function name", () => {
    expect(result.unresolved, "unresolvable writes cannot be judged against the role manifest").toEqual([]);
  });

  // Red while houseTx.ts had claimHouseOwed -> HouseVault.claimOwed() (QUOTER); green since that helper was removed.
  it("no user-facing write targets a function the role manifest restricts", () => {
    const restricted = result.writes
      .filter((w) => w.role !== null && ADMIN_WRITES[`${w.contract}.${w.signature}`] === undefined)
      .map((w) => `${w.site} ${w.contract}.${w.signature} is ${w.role}-only`);
    expect(restricted).toEqual([]);
  });

  it("every allow-listed admin write still exists and is still restricted", () => {
    for (const key of Object.keys(ADMIN_WRITES)) {
      expect(result.writes.some((w) => `${w.contract}.${w.signature}` === key && w.role !== null), key).toBe(true);
    }
  });

  it("a sink argument cast away (`{... } as never`) is still judged, not reported unresolved", () => {
    // stockSwap.ts sends `writeContract({ ...request, account, chain } as never)`; before, the cast hid the object
    // literal and the site failed the resolve case. The same shape carrying its own abi must be judged, not skipped.
    const fixture = {
      file: join(WEB, "lib/v2/cast.wiring-fixture.ts"),
      text: [
        'import { houseVaultAbi } from "../abi/v2/houseVault";',
        "export async function castWrite(wallet: { writeContract: (a: unknown) => Promise<unknown> }, address: string) {",
        '  return wallet.writeContract({ address, abi: houseVaultAbi, functionName: "claimOwed", args: [] } as never);',
        "}",
      ].join("\n"),
    };
    const scanned = scan([fixture]);
    expect(scanned.unresolved.filter((u) => u.site.startsWith("web/lib/v2/cast.wiring-fixture.ts"))).toEqual([]);
    expect(scanned.writes.filter((w) => w.site.startsWith("web/lib/v2/cast.wiring-fixture.ts")))
      .toEqual([expect.objectContaining({ contract: "HouseVault", signature: "claimOwed()", role: "QUOTER" })]);
  });
});

/**
 * The legacy writes, judged against LEGACY_WRITES. `contract` for a legacy ABI is its export name.
 */
describe("every legacy write the app can send is one a plain wallet may send on its own position", () => {
  const legacy = () => result.writes.filter((w) => w.family === "legacy");
  const key = (w: AppWrite) => `${w.contract}.${w.signature}`;

  it("(a) every scanned legacy write has an entry (positive control: the scan sees them)", () => {
    expect(legacy().length).toBeGreaterThan(20);
    const unlisted = legacy().filter((w) => LEGACY_WRITES[key(w)] === undefined).map((w) => `${w.site} ${key(w)} has no LEGACY_WRITES entry`);
    expect(unlisted).toEqual([]);
  });

  it("(b) every entry's access check is one a plain wallet passes on its own position", () => {
    const restricted = legacy()
      .filter((w) => LEGACY_WRITES[key(w)] !== undefined && !PLAIN_WALLET_PASSES.has(LEGACY_WRITES[key(w)]!.access.kind))
      .map((w) => `${w.site} ${key(w)} is ${LEGACY_WRITES[key(w)]!.access.kind}: ${LEGACY_WRITES[key(w)]!.access.check}`);
    expect(restricted).toEqual([]);
  });

  it("(c) every entry matches a scanned write, so the table cannot keep a write the app no longer sends", () => {
    const scanned = new Set(legacy().map(key));
    expect(Object.keys(LEGACY_WRITES).filter((k) => !scanned.has(k))).toEqual([]);
  });

  it("every entry names its check and cites the deployed declaration as repo@SHA:file:line", () => {
    const uncited = Object.entries(LEGACY_WRITES)
      .filter(([, e]) => !/^([\w.-]+\/)?[\w.-]+@[0-9a-f]{40}:[^\s:]+\.sol:\d+$/.test(e.source) || e.access.check.trim() === "")
      .map(([k, e]) => `${k}: ${e.source}`);
    expect(uncited).toEqual([]);
  });
});
