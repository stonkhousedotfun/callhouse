// THE INDEXER IMAGE'S PID 1: run Ponder as a child and redact every line it writes.
//
//   node lib/stdio-redact.mjs <command> [args...]      (indexer/Dockerfile CMD)
//
// WHY A PROCESS AND NOT A LOGGER OPTION. Ponder logs its own RPC failures at warn with the whole error object
// (ponder/src/rpc/index.ts, "Received JSON-RPC error"), the error carries the request URL (ponder/src/rpc/http.ts
// builds HttpRequestError/TimeoutError with `url`; viem prints "URL: <url>" and strips only user:pass), and our
// provider URLs carry the key in the path or query. In `--log-format json` Ponder calls pino() with no destination
// (ponder/src/internal/logger.ts), so pino writes through sonic-boom straight to file descriptor 1. Ponder has no
// hook for this, and lib/log.ts only covers OUR logger. Every byte Ponder, pino, Node or anything else
// in that process writes leaves through fd 1 or fd 2, and this process owns both pipes, so it sees all of it.
//
// WHAT IT DOES
//   - Spawns argv[2..] with shell:false, stdin inherited, stdout and stderr piped.
//   - Rebuilds COMPLETE lines per stream at the Buffer level (a UTF-8 character split across two chunks is never
//     decoded half-way), runs each through redactUrls, and writes it to the matching fd. A line with no URL is
//     written as the original bytes.
//   - Fails closed: a line whose redaction throws is replaced by PLACEHOLDER, never written raw.
//   - Caps a line at LINE_CAP bytes: an over-cap line is written as its redacted head plus TRUNCATED, and every
//     byte after the cap up to the next newline is DROPPED. Never redacted in pieces: the piece after a cut through
//     a URL has no scheme left for the rule to match, so its key would print.
//   - Forwards SIGTERM, SIGINT and SIGQUIT to the child and does not exit on them. Those are the signals Ponder
//     handles (ponder/src/bin/utils/exit.ts), and its shutdown must run to release the schema lock. SIGHUP gets a
//     no-op handler: Ponder has none, so forwarding it would kill Ponder without its shutdown.
//   - Exits after the child's 'close' (every line flushed), never 'exit', with the child's code (Ponder uses 0, 1
//     and 75) or 128 + the signal number. It sets process.exitCode and lets the loop drain; it never calls
//     process.exit, which could cut off its own last writes.
//
// NO DEPENDENCIES AND NO .ts IMPORT: plain `node` runs this file at PID 1, before and outside Ponder's loader.
// Importing it has no side effect (main() is behind an entry-point guard), and nothing in Ponder's process imports
// it: lib/redact.ts must never import this file, or lib/log.ts would load it into Ponder.

import { spawn } from "node:child_process";
import { realpathSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The rule, byte for byte the same as indexer/lib/redact.ts (keeper/src/v2/redact.test.ts runs one corpus
 * through every copy). By shape, never by host: any URL with anything after its host prints as scheme://host/…;
 * a bare origin is left alone. A match never takes a backslash, so a redacted JSON line still parses.
 */
const URL_IN_TEXT = /(?:https?|wss?):\/\/[^\s"'<>`\\]+/gi;

/** @param {string} text */
export function redactUrls(text) {
  return text.replace(URL_IN_TEXT, (raw) => {
    try {
      const url = new URL(raw);
      const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
      return bare ? raw : `${url.protocol}//${url.host}/…`;
    } catch {
      return "[url]";
    }
  });
}

/** The most bytes of one line that are kept. Ponder's JSON lines are a few KB; a stack is under this. */
export const LINE_CAP = 64 * 1024;
/** Written in place of a line whose redaction threw. Fixed text: nothing of the line survives. */
export const PLACEHOLDER = '{"level":50,"service":"stdio-redact","msg":"a log line could not be redacted and was dropped"}';
/** Appended to the redacted head of an over-cap line; the rest of that line is dropped. */
export const TRUNCATED = " [stdio-redact: line truncated]";
/** Exit code when the child cannot be started at all (the shell's "command not found"). */
export const SPAWN_FAILED = 127;
/** The signals passed through to the child. SIGHUP is deliberately not one of them. */
export const FORWARDED_SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGQUIT"]);

/**
 * Fail-closed redaction of one decoded line.
 * @param {string} line
 * @param {(text: string) => string} [redact]
 * @returns {string}
 */
export function safeLine(line, redact = redactUrls) {
  try {
    return redact(line);
  } catch {
    return PLACEHOLDER;
  }
}

/**
 * One line's bytes out: the ORIGINAL bytes when redaction changed nothing (so a line that is not valid UTF-8 is not
 * rewritten by a decode/encode round trip), else the redacted text.
 * @param {Buffer} bytes
 * @param {boolean} truncated
 * @param {(text: string) => string} redact
 * @returns {Buffer}
 */
function renderLine(bytes, truncated, redact) {
  const text = bytes.toString("utf8");
  const out = safeLine(text, redact);
  const body = out === text ? bytes : Buffer.from(out, "utf8");
  return truncated ? Buffer.concat([body, Buffer.from(`${TRUNCATED}\n`, "utf8")]) : Buffer.concat([body, Buffer.from("\n")]);
}

/**
 * A byte stream in, redacted complete lines out. `emit` receives each finished line (newline included) and returns
 * false when its destination wants the producer to pause; push() returns false if any emit did.
 * @param {(line: Buffer) => boolean} emit
 * @param {{ cap?: number, redact?: (text: string) => string }} [options]
 */
export function createLineSplitter(emit, { cap = LINE_CAP, redact = redactUrls } = {}) {
  /** @type {Buffer[]} */
  let parts = [];
  let size = 0;
  let dropping = false;

  /** @param {boolean} truncated */
  const flush = (truncated) => {
    const line = parts.length === 1 ? /** @type {Buffer} */ (parts[0]) : Buffer.concat(parts, size);
    parts = [];
    size = 0;
    return emit(renderLine(line, truncated, redact));
  };

  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      let ok = true;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline;
        if (!dropping) {
          const piece = chunk.subarray(start, end);
          const room = cap - size;
          if (piece.length > room) {
            // Keep the head, write it now, and drop everything to the next newline.
            if (room > 0) parts.push(piece.subarray(0, room));
            size += Math.max(room, 0);
            ok = flush(true) && ok;
            dropping = true;
          } else if (piece.length > 0) {
            parts.push(Buffer.from(piece)); // a copy: the chunk's memory is not ours to hold
            size += piece.length;
          }
        }
        if (newline === -1) break;
        if (dropping) dropping = false;
        else ok = flush(false) && ok;
        start = newline + 1;
      }
      return ok;
    },
    /** The stream ended: an unterminated final line is still written, redacted, with a newline. */
    end() {
      if (!dropping && size > 0) flush(false);
      parts = [];
      size = 0;
      dropping = false;
    },
  };
}

/** @param {NodeJS.ReadableStream} from @param {NodeJS.WritableStream} to */
function pump(from, to) {
  // A destination that errors (its reader went away) drops lines rather than crashing PID 1 and orphaning Ponder.
  to.on("error", () => {});
  const splitter = createLineSplitter((line) => to.write(line));
  from.on("data", (chunk) => {
    if (!splitter.push(chunk)) {
      from.pause();
      to.once("drain", () => from.resume());
    }
  });
  from.on("end", () => splitter.end());
}

/** @param {readonly string[]} argv the command and its arguments */
export function main(argv) {
  if (argv.length === 0) {
    writeSync(2, "stdio-redact: usage: node stdio-redact.mjs <command> [args...]\n");
    process.exitCode = 2;
    return;
  }
  const [command, ...args] = argv;
  const child = spawn(/** @type {string} */ (command), args, { shell: false, stdio: ["inherit", "pipe", "pipe"] });
  let spawnFailed = false;

  pump(/** @type {NodeJS.ReadableStream} */ (child.stdout), process.stdout);
  pump(/** @type {NodeJS.ReadableStream} */ (child.stderr), process.stderr);

  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }
  process.on("SIGHUP", () => {});

  child.on("error", (error) => {
    spawnFailed = true;
    // Fixed text and the error code only: the command line is never echoed.
    const code = /** @type {{ code?: unknown }} */ (error).code;
    writeSync(2, `stdio-redact: could not start the child process (${typeof code === "string" ? code : "error"})\n`);
    process.exitCode = SPAWN_FAILED;
  });

  child.on("close", (code, signal) => {
    if (spawnFailed) return;
    process.exitCode = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0);
  });
}

function isEntryPoint() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main(process.argv.slice(2));
