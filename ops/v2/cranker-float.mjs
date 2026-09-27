#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * The go-live check that the cranker bot holds the USDG float its firstmint step spends.
 *
 * WHY. The first mint of each fresh expiry pins its settlement sources, and the keeper's firstmint step
 * (keeper/src/v2/cranker/firstmint.ts) makes that mint itself by buying one unit of the cheapest ask
 * into the cranker's own account. With no USDG it sends nothing: it pages `v2_first_mint` every tick and every
 * fresh expiry waits, unpinned and unquoted by the House and Earn vaults, for some user's trade. A lifecycle rehearsal measured
 * the production cranker at 0 USDG, and no launch step funded or checked it.
 *
 * THE RULE (thresholds read from the keeper's constants.ts, never typed here):
 *   balance <  FIRST_MINT_MAX_COST                    REFUSE: not one first mint can be paid for
 *   balance <  FIRST_MINT_DAILY_CAP * FLOAT_DAYS      WARN:   it runs dry within FLOAT_DAYS days of full spend
 *   otherwise                                         ok
 * Every message names the address to fund and the exact shortfall in USDG base units (6 decimals). This never
 * sends funds: funding the cranker is a separate, signed transfer.
 *
 *   node ops/v2/cranker-float.mjs --address 0x... --balance 25000000
 *   node ops/v2/cranker-float.mjs --address 0x... --balance 0 --constants keeper/src/v2/cranker/constants.ts
 * Exit 0 ok or warn (the line says which), 1 refuse, 2 usage or an unreadable constant.
 * ------------------------------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONSTANTS_TS = path.resolve(HERE, "..", "..", "keeper", "src", "v2", "cranker", "constants.ts");
/** Days of full first-mint spend the float should cover before go-live stops warning. */
export const FLOAT_DAYS = 5n;
const USDG_UNIT = 1_000_000n;

/** One `export const NAME = 1_234n;` bigint from constants.ts. Anything else (absent, an expression) throws. */
export function readBigintConstant(text, name) {
  const m = text.match(new RegExp(`^export const ${name} = ([0-9][0-9_]*)n;`, "m"));
  if (!m) throw new Error(`${name} is not a plain \`export const ${name} = <digits>n;\` in the keeper's constants.ts`);
  return BigInt(m[1].replaceAll("_", ""));
}

/** FIRST_MINT_MAX_COST and FIRST_MINT_DAILY_CAP, the keeper's own values. */
export function firstMintLimits(file = CONSTANTS_TS) {
  const text = readFileSync(file, "utf8");
  const maxCost = readBigintConstant(text, "FIRST_MINT_MAX_COST");
  const dailyCap = readBigintConstant(text, "FIRST_MINT_DAILY_CAP");
  if (maxCost <= 0n || dailyCap < maxCost) {
    throw new Error(`FIRST_MINT_MAX_COST ${maxCost} and FIRST_MINT_DAILY_CAP ${dailyCap} in ${file} are not a usable pair`);
  }
  return { maxCost, dailyCap };
}

/** Base units as USDG, exact: 500000 -> "0.5". */
export function usdg(units) {
  const whole = units / USDG_UNIT;
  const frac = (units % USDG_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The verdict for one balance: { level: "refuse" | "warn" | "ok", shortfall, message }. */
export function crankerFloat({ address, balance, maxCost, dailyCap, days = FLOAT_DAYS }) {
  const want = dailyCap * days;
  const has = `cranker ${address} holds ${balance} USDG base units (${usdg(balance)} USDG)`;
  if (balance < maxCost) {
    const shortfall = maxCost - balance;
    return {
      level: "refuse",
      shortfall,
      message: `${has}, under FIRST_MINT_MAX_COST ${maxCost} (${usdg(maxCost)} USDG): its firstmint step cannot pin a single new expiry, so House and Earn quote no fresh expiry until a user trades it. Send at least ${shortfall} base units (${usdg(shortfall)} USDG) of USDG to ${address}; ${want} (${usdg(want)} USDG) covers ${days} days of full first-mint spend. This check never sends funds`,
    };
  }
  if (balance < want) {
    const shortfall = want - balance;
    return {
      level: "warn",
      shortfall,
      message: `WARNING: ${has}, under FIRST_MINT_DAILY_CAP x ${days} days = ${want} (${usdg(want)} USDG). Send ${shortfall} base units (${usdg(shortfall)} USDG) of USDG to ${address} before it runs dry`,
    };
  }
  return { level: "ok", shortfall: 0n, message: `${has}, at least FIRST_MINT_DAILY_CAP x ${days} days = ${want}` };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!["--address", "--balance", "--constants"].includes(k) || argv[i + 1] === undefined) throw new Error(`bad argument ${k}`);
    out[k.slice(2)] = argv[++i];
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(out.address ?? "")) throw new Error(`--address must be a 20-byte hex address, got ${JSON.stringify(out.address)}`);
  if (!/^[0-9]+$/.test(out.balance ?? "")) throw new Error(`--balance must be a base-unit integer, got ${JSON.stringify(out.balance)}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let verdict;
  try {
    const args = parseArgs(process.argv.slice(2));
    const { maxCost, dailyCap } = firstMintLimits(args.constants ?? CONSTANTS_TS);
    verdict = crankerFloat({ address: args.address, balance: BigInt(args.balance), maxCost, dailyCap });
  } catch (e) {
    console.error(`cranker-float: ${e.message}`);
    process.exit(2);
  }
  console.log(verdict.message);
  process.exit(verdict.level === "refuse" ? 1 : 0);
}
