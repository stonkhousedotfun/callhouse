/**
 * The relay's HTTP surface, on node:http. Two routes.
 *
 *   GET  /health   200 {status, service, targets}. Unauthenticated; names the configured targets
 *                  and nothing else. This is Railway's healthcheck and the uptime probe.
 *   POST /alert    the keeper's webhook. Authenticate → read (≤ 256 KiB) → parse → validate →
 *                  deliver to every configured target in parallel → answer.
 *
 * WHAT THE KEEPER HEARS, and why it is shaped this way (keeper/src/alerts.ts):
 *   the keeper treats ANY non-2xx, or no answer within 10 s, as a failed delivery and retries
 *   that alert five minutes later (FAILED_DELIVERY_RETRY_MS) instead of holding it for the hour.
 *   So:
 *     200  at least one target accepted. Partial failures are listed in the body and logged,
 *          but a second POST would duplicate the message in the channel that DID get it.
 *     502  every configured target refused or was unreachable. Retrying is correct.
 *     400  not JSON, or not a keeper alert. Retrying will not fix it; the keeper retries anyway,
 *          and the log line here says why.
 *     401  missing or wrong token.
 *     413  body over the cap.
 *
 * AUTHENTICATION. The URL is public on Railway, and an unauthenticated relay is a free way to
 * post anything into the team's alert channel. The token is accepted two ways:
 *   `Authorization: Bearer <RELAY_TOKEN>`   preferred.
 *   `?token=<RELAY_TOKEN>`                  because keeper/src/alerts.ts sends only
 *                                           `content-type` today, so ALERT_WEBHOOK has to carry
 *                                           the token in the URL. A query string lands in
 *                                           proxy access logs; move to the header, and rotate
 *                                           the token, once the keeper can send one.
 * Both are compared in constant time over SHA-256 digests, so neither the token's content nor
 * its length leaks through timing. Authentication runs before the body is read.
 *
 * Nothing here logs a request URL, a header, or a token. See log.ts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RelayConfig } from './config.js';
import type { Logger } from './log.js';
import { parseKeeperAlert } from './payload.js';
import { targetsFromConfig, type DeliveryResult, type Target } from './targets.js';

export const MAX_BODY_BYTES = 256 * 1024;

export interface RelayDeps {
  logger: Logger;
  /** Override the targets built from config. Tests use it; production does not. */
  targets?: Target[];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time: both sides are hashed to 32 bytes first, so unequal lengths cost the same. */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || presented === '') return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return url.searchParams.get('token');
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function summarise(results: DeliveryResult[]) {
  return {
    delivered: results.filter((r) => r.ok).map((r) => r.target),
    failed: results.filter((r) => !r.ok).map((r) => ({ target: r.target, status: r.status, error: r.error ?? 'error' })),
  };
}

export function createRelayServer(config: RelayConfig, deps: RelayDeps): Server {
  const { logger } = deps;
  const targets = deps.targets ?? targetsFromConfig(config);

  const handleAlert = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (!tokenMatches(presentedToken(req, url), config.token)) {
      logger.warn({ route: '/alert', status: 401 }, 'rejected: missing or wrong token');
      // The body is never read on this path; close the connection rather than drain it.
      sendJson(res, 401, { error: 'unauthorized' }, { connection: 'close', 'www-authenticate': 'Bearer' });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        logger.warn({ route: '/alert', status: 413, limitBytes: MAX_BODY_BYTES }, 'rejected: body too large');
        sendJson(res, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` }, { connection: 'close' });
        return;
      }
      throw error;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      logger.warn({ route: '/alert', status: 400 }, 'rejected: body is not JSON');
      sendJson(res, 400, { error: 'body is not valid JSON' });
      return;
    }

    const parsed = parseKeeperAlert(body);
    if (!parsed.ok) {
      logger.warn({ route: '/alert', status: 400, issues: parsed.issues }, 'rejected: not a keeper alert');
      sendJson(res, 400, { error: 'not a keeper alert', issues: parsed.issues });
      return;
    }

    const alert = parsed.alert;
    const results = await Promise.all(targets.map((target) => target.deliver(alert)));
    const summary = summarise(results);

    if (summary.delivered.length > 0) {
      const log = summary.failed.length > 0 ? logger.warn : logger.info;
      log({ route: '/alert', status: 200, kind: alert.kind, severity: alert.severity, ...summary }, 'alert relayed');
      sendJson(res, 200, { ok: true, ...summary });
      return;
    }

    logger.error(
      { route: '/alert', status: 502, kind: alert.kind, severity: alert.severity, ...summary },
      'alert NOT delivered: every target failed',
    );
    sendJson(res, 502, { ok: false, ...summary });
  };

  const server = createServer((req, res) => {
    // A fixed base: the Host header is client-controlled and never needed here.
    const url = new URL(req.url ?? '/', 'http://relay.invalid');

    const route = async (): Promise<void> => {
      if (url.pathname === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
          return;
        }
        sendJson(res, 200, { status: 'ok', service: 'callhouse-relay', targets: targets.map((t) => t.name) });
        return;
      }
      if (url.pathname === '/alert') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
          return;
        }
        await handleAlert(req, res, url);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    };

    route().catch((error: unknown) => {
      logger.error(
        { route: url.pathname, errorName: error instanceof Error ? error.name : typeof error },
        'unhandled error in request',
      );
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  // Bound slow clients. Well above one request's worst case (RELAY_TIMEOUT_MS ≤ 9 s).
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
