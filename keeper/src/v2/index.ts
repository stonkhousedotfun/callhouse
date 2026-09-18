/**
 * The v2 process: V2_MODE picks one of four modes, each behind one start function.
 *
 *   pricing  pricing/main.ts startPricingService (K2-02): no key, HTTP on PRICING_PORT.
 *   cranker  cranker/main.ts startCranker (K2-03)
 *   mm       mm/main.ts startMm (K2-04)
 *   pricer   pricer/main.ts startPricer (K2-05)
 * A mode whose task has not landed throws ModeNotImplementedError and the process exits 1 saying
 * which task builds it, after the configuration has been validated (so an environment can be
 * prepared and checked before the code that uses it ships).
 *
 * Exit codes, as v1: 1 for anything that stops a boot (bad env or registry, a mode not built yet,
 * a port in use, wiring that does not match), with the reason on stderr and no stack trace; 0 after
 * SIGTERM/SIGINT once the mode has finished its in-flight work. Same image as v1, different env
 * (keeper/Dockerfile is unchanged).
 */
import { startPricingService } from './pricing/main.js';
import { redactUrls } from './tx.js';
import { V2ConfigError, loadV2Config, type CrankerConfig, type MmConfig, type PricerConfig, type PricingModeConfig, type V2Config } from './config.js';
import { startCranker } from './cranker/main.js';
import { startMm } from './mm/main.js';
import { ModeNotImplementedError, requestedV2Mode, type RunningMode } from './mode.js';
import { startPricer } from './pricer/main.js';

export interface ModeStarters {
  cranker: (config: CrankerConfig) => Promise<RunningMode>;
  mm: (config: MmConfig) => Promise<RunningMode>;
  pricer: (config: PricerConfig) => Promise<RunningMode>;
  pricing: (config: PricingModeConfig, env: NodeJS.ProcessEnv) => Promise<RunningMode>;
}

async function startPricingMode(_config: PricingModeConfig, env: NodeJS.ProcessEnv): Promise<RunningMode> {
  // startPricingService re-reads the same environment loadV2Config already validated.
  const running = await startPricingService({ env });
  return { mode: 'pricing', port: running.port, close: running.close };
}

export const MODE_STARTERS: ModeStarters = {
  cranker: startCranker,
  mm: startMm,
  pricer: startPricer,
  pricing: startPricingMode,
};

/** Validate the environment and start its mode. Rejects with V2ConfigError, ModeNotImplementedError or a boot error. */
export async function startV2(env: NodeJS.ProcessEnv = process.env, starters: ModeStarters = MODE_STARTERS): Promise<RunningMode> {
  const config: V2Config = loadV2Config(env);
  switch (config.mode) {
    case 'cranker':
      return starters.cranker(config);
    case 'mm':
      return starters.mm(config);
    case 'pricer':
      return starters.pricer(config);
    case 'pricing':
      return starters.pricing(config, env);
  }
}

/** The one-line reason a boot failed, as the operator should read it. */
export function bootFailureMessage(error: unknown, mode: string | undefined): string {
  if (error instanceof ModeNotImplementedError) {
    return `${error.message}. The configuration is valid; nothing was started. Unset V2_MODE for the v1 keeper.`;
  }
  // Printed to stderr on every crash-looping restart: a provider key in an RPC URL must not be (tx.ts redactUrls).
  const reason = redactUrls(error instanceof Error ? error.message : String(error));
  return error instanceof V2ConfigError ? reason : `v2 ${mode ?? 'mode'} failed to start: ${reason}`;
}

/** Process entry, called by src/index.ts when V2_MODE is set. Owns exit codes and signals. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let running: RunningMode;
  try {
    running = await startV2(env);
  } catch (error) {
    process.stderr.write(`\n${bootFailureMessage(error, requestedV2Mode(env))}\n\n`);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${running.mode}: ${signal}, finishing in-flight work\n`);
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${running.mode}: unclean shutdown: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
