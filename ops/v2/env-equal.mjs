#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * O8-05: compare generated v2 env files by assignment lines of selected services.
 *
 * go-live-v2.sh --apply used to `diff -qr` the whole env directory against the reviewed clone.
 * That refused a production monitor because ops/v2/env/pricer.env differed by one comment line
 * (GO-LIVE-V7-SERVICES §4 row 21). Comment-only drift in an unselected file must not block a
 * selected service. Assignment drift in a selected service still refuses.
 *
 *   node ops/v2/env-equal.mjs --local DIR --clone DIR --services a,b
 *   exit 0 when equal; exit 1 with a problem per line on stderr.
 *
 * relay and monitor have no generated env file: missing on both sides is equal.
 * ------------------------------------------------------------------------------------------------- */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Live assignments only. Comments, blanks and `NAME=<secret: …>` comment-lines are ignored. */
export function assignmentLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line));
}

export function compareSelectedEnv({ localDir, cloneDir, services }) {
  const problems = [];
  for (const raw of services) {
    const s = String(raw).trim();
    if (!s) continue;
    const localFile = path.join(localDir, `${s}.env`);
    const cloneFile = path.join(cloneDir, `${s}.env`);
    const localExists = existsSync(localFile);
    const cloneExists = existsSync(cloneFile);
    if (!localExists && !cloneExists) continue;
    if (localExists !== cloneExists) {
      problems.push(`${s}.env exists on only one side of the reviewed SHA`);
      continue;
    }
    const localA = assignmentLines(readFileSync(localFile, "utf8")).join("\n");
    const cloneA = assignmentLines(readFileSync(cloneFile, "utf8")).join("\n");
    if (localA !== cloneA) problems.push(`${s}.env assignments differ from the reviewed SHA`);
  }
  return problems;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const isMain = process.argv[1] && String(process.argv[1]).endsWith("env-equal.mjs");
if (isMain) {
  const localDir = arg("--local");
  const cloneDir = arg("--clone");
  const services = arg("--services");
  if (!localDir || !cloneDir || services == null) {
    process.stderr.write("usage: node ops/v2/env-equal.mjs --local DIR --clone DIR --services a,b\n");
    process.exit(2);
  }
  const problems = compareSelectedEnv({
    localDir,
    cloneDir,
    services: String(services).split(/[,\s]+/),
  });
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}
