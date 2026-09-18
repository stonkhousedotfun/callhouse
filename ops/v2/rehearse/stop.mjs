#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Stops every process the rehearsal recorded in out/services.json (web, bots, notifier, indexer, relay, Postgres,
 * the Telegram and pricing stand-ins, anvil last), each by its recorded process group and start time only, and
 * restores the two generated files a rehearsal rewrites (indexer v2 registry, web markets).
 *
 *   node ops/v2/rehearse/stop.mjs [--except anvil,indexer]
 * ------------------------------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import { ROOT, loadServices, say, stopAll } from "./lib.mjs";

const i = process.argv.indexOf("--except");
const except = i === -1 ? [] : (process.argv[i + 1] ?? "").split(",").filter(Boolean);
const before = Object.keys(loadServices());
await stopAll({ except });
say(`stopped ${before.filter((n) => !except.includes(n)).length} recorded process(es)${except.length ? ` (kept ${except.join(", ")})` : ""}`);
for (const file of ["indexer/lib/v2/marketRegistry.generated.ts", "web/lib/markets.generated.ts"]) {
  const dirty = execFileSync("/opt/homebrew/bin/git", ["-C", ROOT, "status", "--porcelain", "--", file]).toString().trim();
  if (dirty !== "") {
    execFileSync("/opt/homebrew/bin/git", ["-C", ROOT, "checkout", "--", file]);
    say(`restored ${file}`);
  }
}
