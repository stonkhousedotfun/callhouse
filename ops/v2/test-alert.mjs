#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2/test-alert.mjs — POST one boot-shaped alert to a relay (or a local fake).
 *
 *   node ops/v2/test-alert.mjs --url http://127.0.0.1:18080/alert --token-from-stdin
 *   RELAY_TOKEN=… ALERT_WEBHOOK=… node ops/v2/test-alert.mjs --from-env
 *
 * The token is never written to stdout/stderr. A webhook-shaped URL is logged as host only.
 * ------------------------------------------------------------------------------------------------- */
const MAX_TOKEN = 4096;

function usage(code) {
  process.stderr.write(
    "usage: node ops/v2/test-alert.mjs --url <url> --token-from-stdin\n" +
      "       RELAY_TOKEN=… [ALERT_WEBHOOK=…] node ops/v2/test-alert.mjs --from-env [--url <url>]\n",
  );
  process.exit(code);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

async function readTokenFromStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write("RELAY_TOKEN (prefer a pipe; a TTY will echo): ");
  }
  const chunks = [];
  let n = 0;
  for await (const chunk of process.stdin) {
    n += chunk.length;
    if (n > MAX_TOKEN) throw new Error("token too long");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function sendTestAlert({ url, token, source = "callhouse-ops-test", message = "relay wiring test" }) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("url must be http(s)");
  if (typeof token !== "string" || token.trim().length < 32) throw new Error("RELAY_TOKEN must be at least 32 characters");
  const body = JSON.stringify({
    source,
    kind: "boot",
    severity: "info",
    message,
    data: {},
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.trim()}`,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

function parseArgs(argv) {
  const out = { fromEnv: false, tokenFromStdin: false, url: process.env.ALERT_WEBHOOK || "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from-env") out.fromEnv = true;
    else if (a === "--token-from-stdin") out.tokenFromStdin = true;
    else if (a === "--url") {
      out.url = argv[++i] || "";
    } else if (a === "-h" || a === "--help") usage(0);
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      usage(2);
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.url) usage(2);
  let token = "";
  if (args.fromEnv) token = process.env.RELAY_TOKEN || process.env.ALERT_WEBHOOK_TOKEN || "";
  else if (args.tokenFromStdin) token = await readTokenFromStdin();
  else usage(2);
  const result = await sendTestAlert({ url: args.url, token });
  process.stdout.write(`${result.status} ${result.text}\n`);
  process.stderr.write(`posted boot alert to host ${hostOf(args.url)}\n`);
  if (result.status < 200 || result.status >= 300) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("test-alert.mjs")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { hostOf, parseArgs, main };
