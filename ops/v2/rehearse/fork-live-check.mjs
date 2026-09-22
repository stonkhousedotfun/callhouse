#!/usr/bin/env node
/* --check for --fork-live: no anvil, no viem, no keeper install. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertForkOnlyEnv, crankerEnv, forkLiveRegistryArg, nvdaRow, parseServices, thirteenAddresses,
} from "./fork-live-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// The LIVE set, which is v7 -- not tier1.json, which is the v8 registry the numbered steps deploy from.
// See FORK_LIVE_REGISTRY in fork-live-lib.mjs for why these are different files.
const REGISTRY = path.join(ROOT, forkLiveRegistryArg(process.argv));
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

const services = parseServices(argValue("--services"));
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const addresses = thirteenAddresses(registry);
const nvda = nvdaRow(registry);
const env = crankerEnv({
  rpc: "http://127.0.0.1:8590",
  registryPath: REGISTRY,
  db: "/tmp/rehearse-fork-live.check/db/cranker.db",
  port: 42195,
  pk: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  indexerUrl: services.includes("indexer") ? "http://127.0.0.1:42190" : undefined,
});
assertForkOnlyEnv(env);
const planned = {
  mode: "fork-live",
  check: true,
  services,
  registry: REGISTRY,
  publicRpc: "https://rpc.mainnet.chain.robinhood.com",
  addresses,
  nvdaAsset: nvda.asset,
  impersonate: {
    admin: registry.shared.admin,
    guardian: registry.shared.guardian,
  },
  keys: { source: "anvil public junk mnemonic (index 8 for cranker)", callhouseKeysRead: false },
};
if (/callhouse-keys/i.test(JSON.stringify(planned))) {
  throw new Error("planned config mentions callhouse-keys");
}
process.stdout.write("FORK-LIVE --check\n");
process.stdout.write(`${JSON.stringify(planned, null, 2)}\n`);
process.stdout.write("FORK-LIVE CHECK PASSED\n");
