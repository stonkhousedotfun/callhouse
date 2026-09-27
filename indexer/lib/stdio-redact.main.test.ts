/**
 * main() of the PID 1 wrapper, in process. stdio-redact.test.ts drives the real wrapper as a child process (which is
 * the behaviour that matters, but v8 coverage cannot see inside a child); here spawn and writeSync are faked so the
 * wiring itself is asserted: usage error, pumping and redaction of both streams, backpressure, signal forwarding,
 * spawn failure and exit-code mapping. Nothing is spawned and nothing is written to the real fds.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, writeSyncMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), writeSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: writeSyncMock,
}));

const { main, FORWARDED_SIGNALS, SPAWN_FAILED } = await import("./stdio-redact.mjs");

class FakeStream extends EventEmitter {
  paused = false;
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn();
}

const SIGNALS = [...FORWARDED_SIGNALS, "SIGHUP"] as const;
let listenersBefore: Map<string, Function[]>;
let exitCodeBefore: typeof process.exitCode;

beforeEach(() => {
  listenersBefore = new Map(SIGNALS.map((s) => [s, process.listeners(s as NodeJS.Signals)]));
  exitCodeBefore = process.exitCode;
  spawnMock.mockReset();
  writeSyncMock.mockReset();
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal as NodeJS.Signals)) {
      if (!listenersBefore.get(signal)!.includes(listener)) process.off(signal, listener as () => void);
    }
  }
  process.exitCode = exitCodeBefore;
  vi.restoreAllMocks();
});

function run(argv: string[]) {
  const child = new FakeChild();
  spawnMock.mockReturnValue(child);
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  main(argv);
  return { child, stdoutWrite, stderrWrite };
}

const written = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => Buffer.from(c[0] as Buffer).toString("utf8"));

describe("stdio-redact main()", () => {
  it("refuses an empty command with a usage line and exit code 2, spawning nothing", () => {
    main([]);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeSyncMock).toHaveBeenCalledWith(2, expect.stringContaining("usage"));
    expect(process.exitCode).toBe(2);
  });

  it("spawns without a shell, stdin inherited, and redacts complete lines per stream", () => {
    const { child, stdoutWrite, stderrWrite } = run(["ponder", "start", "--log-format", "json"]);
    expect(spawnMock).toHaveBeenCalledWith("ponder", ["start", "--log-format", "json"], {
      shell: false, stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.emit("data", Buffer.from("rpc https://rpc.invalid/v2/FAKEKEY"));
    expect(stdoutWrite).not.toHaveBeenCalled(); // no newline yet
    child.stdout.emit("data", Buffer.from(" failed\nplain\n"));
    child.stderr.emit("data", Buffer.from("wss://ws.invalid/?key=FAKE tail"));
    child.stderr.emit("end");
    expect(written(stdoutWrite)).toEqual(["rpc https://rpc.invalid/… failed\n", "plain\n"]);
    expect(written(stderrWrite)).toEqual(["wss://ws.invalid/… tail\n"]);
    for (const line of [...written(stdoutWrite), ...written(stderrWrite)]) expect(line).not.toContain("FAKE");
  });

  it("pauses the child's stream when the destination is full and resumes it on drain", () => {
    const { child, stdoutWrite } = run(["cmd"]);
    stdoutWrite.mockImplementation(() => false);
    child.stdout.emit("data", Buffer.from("a\n"));
    expect(child.stdout.paused).toBe(true);
    process.stdout.emit("drain");
    expect(child.stdout.paused).toBe(false);
  });

  it("forwards SIGTERM/SIGINT/SIGQUIT to a running child only, and ignores SIGHUP", () => {
    const { child } = run(["cmd"]);
    for (const signal of FORWARDED_SIGNALS) {
      process.listeners(signal as NodeJS.Signals).at(-1)!(signal as NodeJS.Signals);
    }
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGINT"], ["SIGQUIT"]]);
    process.listeners("SIGHUP").at(-1)!("SIGHUP");
    expect(child.kill).toHaveBeenCalledTimes(3);
    child.exitCode = 0;
    process.listeners("SIGTERM").at(-1)!("SIGTERM");
    child.exitCode = null;
    child.signalCode = "SIGTERM";
    process.listeners("SIGINT").at(-1)!("SIGINT");
    expect(child.kill).toHaveBeenCalledTimes(3);
  });

  it("exits with the child's code, or 128 + the signal number", () => {
    const first = run(["cmd"]);
    first.child.emit("close", 75, null);
    expect(process.exitCode).toBe(75);
    vi.restoreAllMocks();
    const second = run(["cmd"]);
    second.child.emit("close", null, "SIGTERM");
    expect(process.exitCode).toBe(128 + 15);
  });

  it("reports a spawn failure with the error code only, exits 127, and ignores the later close", () => {
    const { child } = run(["missing-binary", "--token=FAKE"]);
    child.emit("error", Object.assign(new Error("spawn missing-binary ENOENT"), { code: "ENOENT" }));
    child.emit("close", -2, null);
    expect(process.exitCode).toBe(SPAWN_FAILED);
    const message = String(writeSyncMock.mock.calls[0]![1]);
    expect(message).toContain("(ENOENT)");
    expect(message).not.toContain("missing-binary");
    expect(message).not.toContain("FAKE");
  });

  it("says 'error' when a spawn failure carries no string code", () => {
    const { child } = run(["cmd"]);
    child.emit("error", new Error("boom"));
    expect(String(writeSyncMock.mock.calls[0]![1])).toContain("(error)");
  });
});

describe("redactUrls on a URL-shaped string the URL parser refuses", () => {
  it("replaces it with [url] rather than letting its tail through", async () => {
    const { redactUrls } = await import("./stdio-redact.mjs");
    expect(redactUrls("dial http://[FAKEKEY:1/x failed")).toBe("dial [url] failed");
  });
});
