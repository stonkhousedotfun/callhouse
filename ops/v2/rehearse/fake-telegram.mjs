#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * The rehearsal's Telegram Bot API stand-in. Both the relay (operator alerts, TELEGRAM_API_BASE) and the notifier
 * (user notifications and its /start deep-link bot) talk to it exactly as they talk to api.telegram.org.
 *
 *   POST /bot<token>/getMe        { ok, result: { id, is_bot, username } }
 *   POST /bot<token>/sendMessage  recorded, { ok, result: { message_id, chat, text } }
 *   POST /bot<token>/getUpdates   the updates queued for that token after `offset`, held up to 1 s when none
 *   POST /_control/update         { token, text, chatId } queues a private-chat message for that bot
 *   GET  /_control/messages       every recorded sendMessage: [{ n, at, bot, chatId, text }]
 *   GET  /health                  { ok: true }
 *
 * Every request is also appended to out/logs/telegram.ndjson. Bot tokens are the rehearsal's own placeholders.
 *   node ops/v2/rehearse/fake-telegram.mjs <port> <ndjson file>
 * ------------------------------------------------------------------------------------------------- */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 42194);
const file = process.argv[3] ?? "telegram.ndjson";
const messages = [];
const updates = new Map(); // token -> [{ update_id, message }]
let updateId = 1000;
let messageId = 1;

const body = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try {
        resolve(s === "" ? {} : JSON.parse(s));
      } catch {
        resolve({});
      }
    });
  });
const reply = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") return reply(res, 200, { ok: true });
  if (url.pathname === "/_control/messages") return reply(res, 200, messages);
  const payload = req.method === "POST" ? await body(req) : {};
  if (url.pathname === "/_control/update") {
    const list = updates.get(payload.token) ?? [];
    updateId += 1;
    list.push({ update_id: updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), text: payload.text, chat: { id: Number(payload.chatId), type: "private" }, from: { id: Number(payload.chatId), is_bot: false, first_name: "rehearsal" } } });
    updates.set(payload.token, list);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), control: "update", token: payload.token.split(":")[0], chatId: payload.chatId, text: payload.text })}\n`);
    return reply(res, 200, { ok: true, update_id: updateId });
  }
  const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
  if (!m) return reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  const [, token, method] = m;
  const bot = token.split(":")[0];
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), bot, method, chatId: payload.chat_id ?? null, text: payload.text ?? null })}\n`);
  if (method === "getMe") return reply(res, 200, { ok: true, result: { id: Number(bot) || 4663, is_bot: true, first_name: "Stonkhouse rehearsal", username: `stonkhouse_rehearsal_${bot}_bot` } });
  if (method === "sendMessage") {
    const entry = { n: messages.length + 1, at: new Date().toISOString(), bot, chatId: String(payload.chat_id), text: String(payload.text ?? "") };
    messages.push(entry);
    messageId += 1;
    return reply(res, 200, { ok: true, result: { message_id: messageId, chat: { id: payload.chat_id }, date: Math.floor(Date.now() / 1000), text: entry.text } });
  }
  if (method === "getUpdates") {
    const offset = Number(payload.offset ?? 0);
    const pending = () => (updates.get(token) ?? []).filter((u) => u.update_id >= offset);
    const deadline = Date.now() + Math.min(Number(payload.timeout ?? 0), 1) * 1000;
    while (pending().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return reply(res, 200, { ok: true, result: pending() });
  }
  if (method === "deleteWebhook" || method === "setMyCommands") return reply(res, 200, { ok: true, result: true });
  return reply(res, 200, { ok: true, result: true });
}).listen(port, "127.0.0.1", () => process.stdout.write(`fake telegram on ${port}\n`));
