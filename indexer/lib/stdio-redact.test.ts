/**
 * The indexer image's PID 1 wrapper (./stdio-redact.mjs) redacts every line Ponder writes to fd 1 and fd 2,
 * forwards Ponder's shutdown signals, and exits with Ponder's code. FAKE keys only: nothing here is, or is shaped
 * from, a real key. Every child is `process.execPath -e <code>`; there are no fixture files.
 *
 * The cases are lettered: (a) a pino-shaped line written with fs.writeSync, as sonic-boom writes it;
 * (b) a URL split across two writes inside its host; (c) an unterminated last line; (d) exit codes; (e) signals;
 * (f) fail-closed; (g) the line cap; (h) byte-identical passthrough; (i) no side effect on import.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LINE_CAP, PLACEHOLDER, SPAWN_FAILED, TRUNCATED, createLineSplitter, redactUrls, safeLine } from "./stdio-redact.mjs";

const WRAPPER = fileURLToPath(new URL("./stdio-redact.mjs", import.meta.url));
const KEYED = "https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY0123456789abcdef";
const REDACTED = "https://robinhood-mainnet.g.alchemy.com/…";

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer };

/** Starts `node <args>` and collects both streams; `onStdout` sees stdout as it arrives. */
function start(args: string[], onStdout?: (soFar: string, pid: number) => void) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    out.push(chunk);
    onStdout?.(Buffer.concat(out).toString("utf8"), child.pid!);
  });
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const done = new Promise<Run>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })));
  return { child, done };
}

/** The wrapper around a `node -e <code>` child. */
function wrapped(code: string, onStdout?: (soFar: string, pid: number) => void) {
  return start([WRAPPER, process.execPath, "-e", code], onStdout);
}

const lines = (b: Buffer) => b.toString("utf8").split("\n").filter((l) => l !== "");

describe("(a) a pino-shaped line written straight to fd 1 and fd 2", () => {
  // The shape Ponder's json logger emits for "Received JSON-RPC error": viem's HttpRequestError message carries
  // "URL: <url>", and its own `url` property is serialized beside it.
  const CHILD = `
    const fs = require("node:fs");
    const url = ${JSON.stringify(KEYED)};
    const message = "HTTP request failed.\\n\\nURL: " + url + "\\nRequest body: {\\"method\\":\\"eth_getLogs\\"}";
    const line = JSON.stringify({ level: 40, time: 1, msg: "Received JSON-RPC error", error: {
      name: "HttpRequestError", message, url, stack: "HttpRequestError: " + message + "\\n    at x (y.js:1:1)" } }) + "\\n";
    fs.writeSync(1, line);
    fs.writeSync(2, line);
  `;

  it("control: without the wrapper the child really prints the key", async () => {
    const r = await start(["-e", CHILD]).done;
    expect(r.stdout.toString()).toContain("FAKEKEY");
    expect(r.stderr.toString()).toContain("FAKEKEY");
  });

  it("through the wrapper: no FAKE on either fd, and each line still parses", async () => {
    const r = await wrapped(CHILD).done;
    expect(r.code).toBe(0);
    for (const stream of [r.stdout, r.stderr]) {
      const text = stream.toString("utf8");
      expect(text).not.toContain("FAKE");
      const [only, ...rest] = lines(stream);
      expect(rest).toEqual([]);
      const parsed = JSON.parse(only!) as { msg: string; error: { url: string; message: string } };
      expect(parsed.msg).toBe("Received JSON-RPC error");
      expect(parsed.error.url).toBe(REDACTED);
      expect(parsed.error.message).toContain(`URL: ${REDACTED}`);
    }
  });

  it("a real viem HttpRequestError logged through pino() with no destination (Ponder's own path)", async () => {
    // Resolved READ-ONLY from Ponder's own dependency tree, the pino and viem the image ships.
    const ponderDir = realpathSync(fileURLToPath(new URL("../node_modules/ponder", import.meta.url)));
    const fromPonder = createRequire(join(ponderDir, "package.json"));
    const pinoPath = fromPonder.resolve("pino");
    const viemPath = fromPonder.resolve("viem");
    const child = `
      const pino = require(${JSON.stringify(pinoPath)});
      const { HttpRequestError } = require(${JSON.stringify(viemPath)});
      const logger = pino({ level: "warn", serializers: { error: pino.stdSerializers.err }, base: undefined });
      logger.warn({ msg: "Received JSON-RPC error", error: new HttpRequestError({ url: ${JSON.stringify(KEYED)}, body: { method: "eth_getLogs" } }) });
    `;
    const control = await start(["-e", child]).done;
    expect(control.stdout.toString(), "control: pino really prints the key to fd 1").toContain("FAKEKEY");
    const r = await wrapped(child).done;
    expect(r.code).toBe(0);
    expect(r.stdout.toString()).not.toContain("FAKE");
    const parsed = JSON.parse(lines(r.stdout)[0]!) as { error: { url: string } };
    expect(parsed.error.url).toBe(REDACTED);
  });
});

describe("(b) a URL split across two writes, the split inside the host", () => {
  it("is rebuilt into one line before redaction, so the key in the second write never prints", async () => {
    const cut = KEYED.indexOf("mainnet") + 3; // inside the host: the whole key arrives in the second write
    const r = await wrapped(`
      const fs = require("node:fs");
      fs.writeSync(1, ${JSON.stringify(`{"msg":"x","url":"${KEYED.slice(0, cut)}`)});
      setTimeout(() => fs.writeSync(1, ${JSON.stringify(`${KEYED.slice(cut)}"}\n`)}), 50);
    `).done;
    expect(r.stdout.toString()).not.toContain("FAKE");
    expect(r.stdout.toString()).toBe(`{"msg":"x","url":"${REDACTED}"}\n`);
  });
});

describe("(c) an unterminated final line", () => {
  it("is flushed at the end of the stream, redacted", async () => {
    const r = await wrapped(`require("node:fs").writeSync(1, "tail " + ${JSON.stringify(KEYED)});`).done;
    expect(r.stdout.toString()).toBe(`tail ${REDACTED}\n`);
  });
});

describe("(d) the child's exit is the wrapper's exit", () => {
  for (const code of [0, 1, 75]) {
    it(`exit ${code} is propagated`, async () => {
      expect((await wrapped(`process.exit(${code})`).done).code).toBe(code);
    });
  }

  it("a child killed by SIGKILL gives 128 + 9", async () => {
    expect((await wrapped(`process.kill(process.pid, "SIGKILL")`).done).code).toBe(137);
  });

  it("a command that cannot start gives a fixed message on fd 2 and a non-zero exit", async () => {
    const r = await start([WRAPPER, "/nonexistent/FAKE-binary", "--rpc", KEYED]).done;
    expect(r.code).toBe(SPAWN_FAILED);
    expect(r.stderr.toString()).toBe("stdio-redact: could not start the child process (ENOENT)\n");
    expect(r.stdout.length).toBe(0);
  });
});

describe("(e) signals", () => {
  // The child mirrors Ponder (exit.ts): a handler per signal that logs, then shuts down after a moment.
  const CHILD = `
    const fs = require("node:fs");
    for (const s of ["SIGTERM", "SIGINT", "SIGQUIT"]) process.on(s, () => {
      fs.writeSync(1, "GOT " + s + "\\n");
      setTimeout(() => { fs.writeSync(1, "SHUTDOWN DONE\\n"); process.exit(0); }, 150);
    });
    process.on("SIGHUP", () => fs.writeSync(1, "GOT SIGHUP\\n"));
    fs.writeSync(1, "READY\\n");
    setInterval(() => {}, 1000);
  `;

  for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"] as const) {
    it(`${signal} reaches the child's handler, and the wrapper exits 0 only after the child's last line`, async () => {
      let sent = false;
      const { done } = wrapped(CHILD, (soFar, pid) => {
        if (!sent && soFar.includes("READY")) { sent = true; process.kill(pid, signal); }
      });
      const r = await done;
      expect(r.code).toBe(0);
      expect(lines(r.stdout)).toEqual(["READY", `GOT ${signal}`, "SHUTDOWN DONE"]);
    });
  }

  it("SIGHUP is not forwarded, and the wrapper keeps running", async () => {
    let wrapperPid = 0;
    const { child, done } = wrapped(CHILD, (soFar, pid) => {
      if (!wrapperPid && soFar.includes("READY")) { wrapperPid = pid; process.kill(pid, "SIGHUP"); }
    });
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (wrapperPid) { clearInterval(t); resolve(); } }, 10); });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(child.exitCode, "the wrapper is still running after SIGHUP").toBeNull();
    process.kill(wrapperPid, "SIGTERM");
    const r = await done;
    expect(r.stdout.toString()).not.toContain("GOT SIGHUP");
    expect(lines(r.stdout)).toEqual(["READY", "GOT SIGTERM", "SHUTDOWN DONE"]);
    expect(r.code).toBe(0);
  });
});

describe("(f) fail closed", () => {
  it("a redaction that throws writes the fixed placeholder, never the raw line", () => {
    const raw = `boom ${KEYED}`;
    const out = safeLine(raw, () => { throw new Error("redaction broke"); });
    expect(out).toBe(PLACEHOLDER);
    expect(out).not.toContain("FAKE");
    expect(out).not.toContain("boom");
  });

  it("the splitter uses the fail-closed path too", () => {
    const got: string[] = [];
    const split = createLineSplitter((line) => { got.push(line.toString()); return true; }, { redact: () => { throw new Error("x"); } });
    split.push(Buffer.from(`raw ${KEYED}\n`));
    expect(got).toEqual([`${PLACEHOLDER}\n`]);
  });
});

describe("(g) the line cap", () => {
  // Every run of "FAKE" survives any cut, so a key cut in two still leaves a FAKE in the piece after the cut.
  const KEY = "FAKE".repeat(12);

  it("an over-cap line prints its redacted head and the marker, and drops the rest up to the next newline", () => {
    const got: string[] = [];
    const split = createLineSplitter((line) => { got.push(line.toString()); return true; }, { cap: 64 });
    const head = "x".repeat(10); // the cap (64) lands inside KEY: " https://rpc.example.com/v2/" ends at byte 38
    const line = `${head} https://rpc.example.com/v2/${KEY} and https://other.example/v2/${KEY}\n`;
    expect(Buffer.byteLength(line)).toBeGreaterThan(64);
    split.push(Buffer.from(line.slice(0, 50)));
    split.push(Buffer.from(`${line.slice(50)}next line\n`));
    expect(got.join("")).not.toContain("FAKE");
    expect(got).toEqual([`${head} https://rpc.example.com/…${TRUNCATED}\n`, "next line\n"]);
  });

  it("through the wrapper at LINE_CAP: a FAKE straddling the cap and one after it both stay hidden", async () => {
    const pad = LINE_CAP - 30;
    const r = await wrapped(`
      const fs = require("node:fs");
      fs.writeSync(1, "x".repeat(${pad}) + " https://rpc.example.com/v2/${KEY} then https://b.example/${KEY}\\n" + "next line\\n");
    `).done;
    const text = r.stdout.toString();
    expect(text).not.toContain("FAKE");
    expect(text).toContain(TRUNCATED);
    expect(lines(r.stdout).at(-1)).toBe("next line");
  });
});

describe("(h) byte-identical passthrough", () => {
  it("a line with no URL, a multi-byte character split across two writes inside it, prints as its exact bytes", async () => {
    const text = "héllo wörld € 日本 — no url here\n";
    const bytes = Buffer.from(text, "utf8");
    const cut = bytes.indexOf(Buffer.from("€", "utf8")) + 1; // inside the three bytes of €
    const r = await wrapped(`
      const fs = require("node:fs");
      const b = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");
      fs.writeSync(1, b.subarray(0, ${cut}));
      setTimeout(() => fs.writeSync(1, b.subarray(${cut})), 50);
    `).done;
    expect(r.stdout.equals(bytes)).toBe(true);
  });

  it("bytes that are not valid UTF-8 pass through untouched too", async () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a]);
    const r = await wrapped(`require("node:fs").writeSync(1, Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a]))`).done;
    expect(r.stdout.equals(bytes)).toBe(true);
  });
});

describe("(i) importing the module has no side effect", () => {
  it("spawns nothing and adds no signal listener, even with a command left in argv", async () => {
    // argv.slice(2) of this child is [node, -e, process.exit(0)]: if main() ran on import it would spawn that
    // command and install the four listeners.
    const probe = `
      const before = ["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP"].map((s) => process.listenerCount(s));
      import(${JSON.stringify(new URL("./stdio-redact.mjs", import.meta.url).href)}).then((m) => {
        const after = ["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP"].map((s) => process.listenerCount(s));
        process.stdout.write(JSON.stringify({ before, after, redacts: m.redactUrls(${JSON.stringify(KEYED)}) }) + "\\n");
      });
    `;
    const r = await start(["-e", probe, "argv1", process.execPath, "-e", "process.exit(0)"]).done;
    expect(r.code).toBe(0);
    expect(r.stderr.toString()).toBe("");
    const out = JSON.parse(r.stdout.toString()) as { before: number[]; after: number[]; redacts: string };
    expect(out.after).toEqual(out.before);
    expect(out.redacts).toBe(REDACTED);
  });

  it("the wrapper's rule is the keeper's keyed-URL rule (the keeper drift test runs the full corpus)", () => {
    expect(redactUrls(`URL: ${KEYED}\nnext`)).toBe(`URL: ${REDACTED}\nnext`);
    expect(redactUrls("https://rpc.mainnet.chain.robinhood.com")).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
});
