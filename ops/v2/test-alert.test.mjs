/**
 *   node --test ops/v2/test-alert.test.mjs
 *
 * Local fake target. No Railway, no Discord, no Telegram.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deliveryVerdict, hostOf, sendTestAlert } from "./test-alert.mjs";

const TOKEN = "a".repeat(32);

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/alert` });
    });
  });
}

test("delivers a boot alert to a local fake target", async () => {
  let seen;
  const { server, url } = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = {
        method: req.method,
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered: ["fake"], failed: [] }));
    });
  });
  try {
    const result = await sendTestAlert({ url, token: TOKEN });
    assert.equal(result.status, 200);
    assert.match(result.text, /"delivered":\["fake"\]/);
    assert.equal(seen.method, "POST");
    assert.equal(seen.auth, `Bearer ${TOKEN}`);
    assert.equal(seen.body.kind, "boot");
    assert.equal(seen.body.severity, "info");
  } finally {
    server.close();
  }
});

test("refuses a short token and does not hit the network", async () => {
  await assert.rejects(() => sendTestAlert({ url: "http://127.0.0.1:1/alert", token: "short" }), /32 characters/);
});

test("hostOf never returns a webhook path", () => {
  assert.equal(hostOf("https://discord.com/api/webhooks/123/SECRET"), "discord.com");
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-alert.mjs");

function runCli(url) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "--from-env", "--url", url], { env: { ...process.env, RELAY_TOKEN: TOKEN, ALERT_WEBHOOK: "" } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test("A 200 with a failed target is a partial delivery, and the CLI exits 1", async () => {
  // The relay's own shape (relay/src/server.ts summarise): one target delivered, one failed, HTTP 200.
  const { server, url } = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered: ["discord"], failed: [{ target: "telegram", status: 502, error: "bad gateway" }] }));
    });
  });
  try {
    const run = await runCli(url);
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /NOT DELIVERED: 1 target\(s\) failed: telegram/);
    assert.doesNotMatch(run.stderr + run.stdout, new RegExp(TOKEN));
  } finally {
    server.close();
  }
});

test("Control — every target delivered exits 0", async () => {
  const { server, url } = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered: ["discord", "telegram"], failed: [] }));
    });
  });
  try {
    const run = await runCli(url);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /DELIVERED: delivered to discord, telegram/);
  } finally {
    server.close();
  }
});

test("An answer that says nothing about delivery is not a delivery", () => {
  assert.equal(deliveryVerdict({ status: 200, text: "ok" }).ok, false);
  assert.equal(deliveryVerdict({ status: 200, text: JSON.stringify({ ok: true }) }).ok, false);
  assert.equal(deliveryVerdict({ status: 200, text: JSON.stringify({ ok: true, delivered: [], failed: [] }) }).ok, false);
  assert.equal(deliveryVerdict({ status: 502, text: JSON.stringify({ ok: false, delivered: [], failed: [{ target: "discord" }] }) }).ok, false);
  assert.equal(deliveryVerdict({ status: 200, text: JSON.stringify({ ok: true, delivered: ["discord"], failed: [] }) }).ok, true);
});
