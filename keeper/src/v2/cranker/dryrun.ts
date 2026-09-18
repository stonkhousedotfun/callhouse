/**
 * The cranker's dry run: one tick against a live chain, printing what each step would do. Nothing
 * is signed or sent, no alert leaves the process, and the SQLite database is in memory whatever
 * KEEPER_DB_PATH says (the log index is rebuilt from the deploy block on every run).
 *
 *   pnpm --filter @callhouse/keeper v2:dryrun                        # the environment (and ./.env or KEEPER_ENV_FILE)
 *   KEEPER_ENV_FILE=../ops/devnet/env/cranker.env pnpm --filter @callhouse/keeper v2:dryrun
 *   pnpm --filter @callhouse/keeper v2:dryrun -- --json              # the tick report as JSON
 *
 * The environment is the cranker's (keeper/src/v2/config.ts), with V2_MODE forced to `cranker` and
 * CRANKER_PK optional: without one the simulations run as a throwaway address (a bounty or an
 * access rule that depends on the caller can then differ from the real key's).
 *
 * WHAT IT CANNOT SHOW. Steps of one tick do not see each other's effects: after a `would-send`
 * finalize, the settle step still reads the expiry as not final. The live cranker sends, so its
 * next step does see it.
 */
import { config as loadDotenv } from 'dotenv';
import { generatePrivateKey } from 'viem/accounts';
import { V2ConfigError, loadV2Config, type CrankerConfig } from '../config.js';
import { createV2Logger } from '../logger.js';
import { createModeRuntime } from '../runtime.js';
import { bigintReplacer } from '../store.js';
import { redactUrls } from '../tx.js';
import { createCranker } from './main.js';
import type { TickReport } from './cranker.js';

function render(report: TickReport, signerNote: string): string {
  const lines: string[] = [];
  lines.push(`cranker dry run at head block ${report.head?.blockNumber ?? '?'} (timestamp ${report.head?.timestamp ?? '?'}, ${report.head ? new Date(report.head.timestamp * 1000).toISOString() : '?'})`);
  lines.push(signerNote);
  lines.push(`expiries surveyed: ${report.expiries.length}`);
  for (const step of report.reports) {
    lines.push('');
    lines.push(`== ${step.step}`);
    if (step.actions.length === 0) lines.push('  nothing to send');
    for (const a of step.actions) {
      const detail = a.status === 'simulation-reverted' ? ` (${a.revert ?? a.error ?? 'reverted'})` : a.result !== undefined ? ` → ${JSON.stringify(a.result, bigintReplacer)}` : '';
      lines.push(`  [${a.status}] ${a.what}${detail}`);
    }
    const notes = JSON.stringify(step.notes, bigintReplacer, 2);
    if (notes !== '{}') lines.push(...notes.split('\n').map((l) => `  ${l}`));
    if (step.wakeAt.length > 0) lines.push(`  time-critical at: ${[...new Set(step.wakeAt)].sort((a, b) => a - b).join(', ')}`);
  }
  for (const e of report.errors) lines.push(`\n!! ${e.step} failed: ${e.message}`);
  if (report.alerts.length > 0) {
    lines.push('\n== alerts the live cranker would raise');
    for (const a of report.alerts) lines.push(`  ${a.kind}: ${a.message}`);
  }
  return lines.join('\n');
}

export async function dryRun(env: NodeJS.ProcessEnv, options: { json: boolean }): Promise<{ text: string; report: TickReport }> {
  // Always in memory: the live cranker's journal (in-flight transactions) and index are never touched.
  const input: NodeJS.ProcessEnv = { ...env, V2_MODE: 'cranker', KEEPER_DB_PATH: ':memory:' };
  let signerNote = 'simulating as the configured CRANKER_PK';
  if (input.CRANKER_PK === undefined || input.CRANKER_PK.trim() === '') {
    input.CRANKER_PK = generatePrivateKey();
    signerNote = 'simulating as a throwaway address (CRANKER_PK unset)';
  }
  const config = loadV2Config(input) as CrankerConfig;
  const runtime = createModeRuntime(config, { log: createV2Logger({ level: options.json ? 'silent' : (config.logLevel === 'info' ? 'warn' : config.logLevel), mode: 'cranker-dryrun' }) });
  try {
    const cranker = createCranker(runtime, { dryRun: true });
    const report = await cranker.tick();
    return { text: options.json ? JSON.stringify(report, bigintReplacer, 2) : render(report, `${signerNote}: ${runtime.signer.account.address}`), report };
  } finally {
    runtime.store.close();
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  loadDotenv({ path: process.env.KEEPER_ENV_FILE, quiet: true });
  const json = process.argv.includes('--json');
  try {
    const { text, report } = await dryRun(process.env, { json });
    process.stdout.write(`${text}\n`);
    process.exit(report.errors.length > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${error instanceof V2ConfigError ? error.message : `dry run failed: ${redactUrls(error instanceof Error ? error.message : String(error))}`}\n`);
    process.exit(1);
  }
}
