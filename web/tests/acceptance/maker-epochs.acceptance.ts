import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMakerEpochFile } from "../../lib/v2/makerRewards";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT = process.env.GIT_BIN?.trim() || "git";
const DOCKER = process.env.DOCKER_BIN?.trim() || "docker";
const EPOCH = 2958;
const FIXTURE = join(ROOT, "indexer/src/v2/fixtures/maker-epoch-2958.oz.json");
const RUN_ID = `${process.pid}-${Date.now()}`;
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "callhouse-maker-epochs-"));
const containers = new Set<string>();
const images = new Set<string>();

function command(
  executable: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding & { allowFailure?: boolean } = { encoding: "utf8" },
) {
  const { allowFailure = false, ...spawnOptions } = options;
  const result = spawnSync(executable, args, { encoding: "utf8", ...spawnOptions });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"})\n`
      + `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

function exportHead(destination: string) {
  mkdirSync(destination, { recursive: true });
  const archive = join(TEMP_ROOT, `${basename(destination)}.tar`);
  command(GIT, ["-C", ROOT, "archive", "--format=tar", "--output", archive, "HEAD"]);
  command("tar", ["-xf", archive, "-C", destination]);
}

function addFixture(context: string) {
  const source = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  const published = {
    epoch: source.epoch,
    root: source.root,
    total: source.total,
    posted: false,
    entries: source.entries,
  };
  const directory = join(context, "ops/maker-epochs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${EPOCH}.json`), `${JSON.stringify(published, null, 2)}\n`);
}

function build(context: string, variant: "empty" | "fixture") {
  const image = `callhouse-maker-epochs-${variant}:${RUN_ID}`;
  command(DOCKER, ["build", "--progress=plain", "--file", "web/Dockerfile", "--tag", image, context], {
    encoding: "utf8",
    stdio: "inherit",
  });
  images.add(image);
  return image;
}

async function start(image: string, variant: "empty" | "fixture") {
  const name = `callhouse-maker-epochs-${variant}-${RUN_ID}`;
  command(DOCKER, ["run", "--detach", "--publish", "127.0.0.1::3000", "--name", name, image]);
  containers.add(name);
  const inspected = command(DOCKER, [
    "inspect",
    "--format",
    "{{(index (index .NetworkSettings.Ports \"3000/tcp\") 0).HostPort}}",
    name,
  ]);
  const port = inspected.stdout.trim();
  assert.match(port, /^\d+$/, "Docker did not allocate a host port");
  const url = `http://127.0.0.1:${port}/maker-epochs/${EPOCH}.json`;
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return { response: await fetch(url), url };
    } catch (error) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  throw new Error(`container did not serve ${url}: ${String(lastError)}`);
}

function cleanup() {
  for (const container of containers) {
    command(DOCKER, ["rm", "--force", container], { encoding: "utf8", allowFailure: true });
  }
  for (const image of images) {
    command(DOCKER, ["image", "rm", "--force", image], { encoding: "utf8", allowFailure: true });
  }
  rmSync(TEMP_ROOT, { recursive: true, force: true });
}

async function main() {
  const emptyContext = join(TEMP_ROOT, "empty");
  const fixtureContext = join(TEMP_ROOT, "fixture");
  exportHead(emptyContext);
  exportHead(fixtureContext);
  addFixture(fixtureContext);

  const emptyImage = build(emptyContext, "empty");
  const empty = await start(emptyImage, "empty");
  assert.equal(empty.response.status, 404, `empty image fabricated ${empty.url}`);

  const fixtureImage = build(fixtureContext, "fixture");
  const fixture = await start(fixtureImage, "fixture");
  assert.equal(fixture.response.status, 200, `fixture image did not serve ${fixture.url}`);
  const parsed = parseMakerEpochFile(await fixture.response.json(), EPOCH);
  assert.equal(parsed.epoch, EPOCH);
  assert.equal(parsed.entries.length, 4);
  process.stdout.write("W3-202 MAKER EPOCH IMAGE ACCEPTANCE PASSED: empty=404 fixture=parsed\n");
}

try {
  await main();
} finally {
  cleanup();
}
