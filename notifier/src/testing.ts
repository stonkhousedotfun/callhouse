/**
 * Test helpers shared by the *.test.ts files. Never imported by production code (index.ts and
 * app.ts do not reach it), so its dev-only dependency, PGlite, is absent from the deployed tree
 * without harm.
 *
 * WHY PGLITE AND NOT pg-mem: the storage layer leans on Postgres features pg-mem does not
 * implement or implements loosely — partial unique indexes as ON CONFLICT arbiters, `xmax` in
 * RETURNING, UPDATE … FROM with a FOR UPDATE SKIP LOCKED subquery, advisory locks, jsonb,
 * gen_random_uuid(). PGlite is the real Postgres parser and executor compiled to WASM, so the SQL
 * the tests run is byte for byte the SQL production runs, with no emulation gap to hide a bug in.
 */
import { PGlite } from '@electric-sql/pglite';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig, type NotifierConfig } from './config.js';
import { migrate, type Db, type Queryable, type TxHandle } from './db.js';
import { createLogger, type Logger } from './log.js';

/* ------------------------------------------------------------------ database */

export interface TestDb extends Db {
  /** Empty every notifier table (schema and migrations stay). */
  reset(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;
  const adapt = (client: { query: PGlite['query'] }): Queryable => ({
    async query<R>(text: string, params: unknown[] = []) {
      const result = await client.query<R>(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const db: TestDb = {
    ...adapt(pg),
    transaction: (fn) =>
      pg.transaction(async (tx) => {
        const handle: TxHandle = {
          ...adapt(tx),
          async exec(sql) {
            await tx.exec(sql);
          },
        };
        return fn(handle);
      }),
    close: () => pg.close(),
    async reset() {
      await pg.exec(
        'TRUNCATE notifier.delivery, notifier.subscription, notifier.nonce, notifier.telegram_link, notifier.rules_state, notifier.rules_holdings, notifier.email_confirmation_budget, notifier.email_suppression',
      );
    },
  };
  await migrate(db);
  return db;
}

/* ------------------------------------------------------------------ time, logs */

export const T0 = Date.parse('2026-09-16T21:00:00Z');

export class TestClock {
  constructor(public ms = T0) {}
  readonly now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger((line) => lines.push(line)), lines };
}

/* ------------------------------------------------------------------ config */

export const TEST_DATA_KEY_HEX = 'a1'.repeat(32);
export const TEST_BOT_TOKEN = '123456:TEST-SECRET-BOT-TOKEN-abcdefghij';

function vapidPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey() drops leading zero bytes (about 1 key in 256), and web-push refuses a private key that is not
  // exactly 32 bytes, so pad it back.
  const privateKey = Buffer.from(ecdh.getPrivateKey().toString('hex').padStart(64, '0'), 'hex');
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: privateKey.toString('base64url') };
}

export const TEST_VAPID = vapidPair();

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://notifier:SECRET-DB-PASSWORD@db.invalid:5432/railway',
    INDEXER_URL: 'http://indexer.invalid',
    RH_RPC: 'https://rpc.invalid',
    NOTIFIER_DATA_KEY: TEST_DATA_KEY_HEX,
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
    VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
    APP_URL: 'https://app.stonkhouse.test',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): NotifierConfig {
  return parseConfig(testEnv(overrides));
}

/* ------------------------------------------------------------------ web push keys */

/** A browser-side PushSubscription for `endpoint`, with real P-256 / auth keys. */
export function browserSubscription(endpoint: string): { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

/* ------------------------------------------------------------------ sample events */

const usdg = (raw: string) => ({ raw, decimals: 6, formatted: String(Number(raw) / 1e6) });

/** A full §4 SeriesRef (from ops/fixtures/api/v2): NVDA 221 call, Fri 25 Sep 2026 16:00 New York. */
export const SERIES_221 = {
  longId: '29578741721805883636096061263188069692265858688783836537835344212255512771642',
  shortId: '29578741721805883636096061263188069692265858688783836537835344212255512771643',
  ticker: 'NVDA',
  underlying: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  isPut: false,
  strike: usdg('221000000'),
  expiry: 1790366400,
  tenor: 'weekly',
  mintCutoff: 1790364600,
  status: 'open',
};

/** NVDA 216 call, Fri 11 Sep 2026, settled at 219.40. */
export const SERIES_216 = {
  longId: '43293694946995027951420864636341246531661381642010273628732417116006111144922',
  ticker: 'NVDA',
  isPut: false,
  strike: usdg('216000000'),
  expiry: 1789156800,
};

export const SAMPLE_ADDRESS = '0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';

/** One valid payload per §6 event kind. */
export const SAMPLE_PAYLOADS = {
  fill_receipt: { series: SERIES_221, side: 'buy', units: '50', price: usdg('3600000'), total: usdg('1900000'), fee: usdg('100000'), primary: true },
  strike_cross: { series: SERIES_221, position: 'long', direction: 'above', spot: usdg('221400000'), units: '50', cost: usdg('1900000') },
  price_alert: { ticker: 'NVDA', direction: 'above', threshold: usdg('221000000'), spot: usdg('221400000') },
  expiry_24h: { series: SERIES_221, position: 'long', units: '50', spot: usdg('219100000'), cost: usdg('1900000') },
  expiry_1h: { series: SERIES_221, position: 'short', units: '50', spot: usdg('219100000') },
  settlement_receipt: {
    series: SERIES_216,
    position: 'long',
    units: '40',
    settlementPrice: usdg('219400000'),
    payout: { asset: 'usdg', amount: usdg('1360000') },
    cost: usdg('500000'),
    toLedger: false,
  },
  writer_itm_warning: {
    series: SERIES_221,
    units: '50',
    spot: usdg('222100000'),
    collateralLocked: { raw: '500000000000000000', decimals: 18 },
  },
  auto_roll: { ticker: 'NVDA', status: 'rolled', series: SERIES_221, price: usdg('260000'), units: '100' },
  payout_failed_to_ledger: { series: SERIES_216, asset: 'usdg', amount: usdg('1360000') },
  fee_notice: { phase: 'scheduled', effectiveAt: 1789896000 },
  admin_operation: { id: `0x${'ab'.repeat(32)}`, status: 'pending', label: 'setMarketFees' },
} as const;

/* ------------------------------------------------------------------ fake http services */

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export type FakeHandler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export interface FakeServer {
  url: string;
  requests: Recorded[];
  handler: FakeHandler;
  close(): Promise<void>;
}

/** A local HTTP server on 127.0.0.1 that records every request and answers with `handler`. */
export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const fake: Partial<FakeServer> & { requests: Recorded[]; handler: FakeHandler } = { requests: [], handler };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      fake.requests.push(recorded);
      void Promise.resolve(fake.handler(recorded, res)).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake as FakeServer;
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
