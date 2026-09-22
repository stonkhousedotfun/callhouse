/**
 *   node --test ops/v2/test-alert.test.mjs
 *
 * Local fake target. No Railway, no Discord, no Telegram.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { hostOf, sendTestAlert } from "./test-alert.mjs";

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
