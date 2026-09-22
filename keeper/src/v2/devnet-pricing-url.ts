/**
 * The devnet harnesses' `--pricing-url` flag (K3-304): point v2:devnet-pricer and v2:devnet-mm at
 * a real running pricing service instead of the in-process stub. Precedence: the flag wins over
 * the PRICING_URL environment variable; with neither, the harness keeps its default stub.
 *
 *   pnpm --filter @callhouse/keeper v2:devnet-pricer -- --pricing-url http://127.0.0.1:8790
 *   PRICING_URL=http://127.0.0.1:8790 pnpm --filter @callhouse/keeper v2:devnet-mm
 *
 * Pure: no I/O beyond reading the given argv/env, so the tests cover every path offline.
 */

export type DevnetPricingUrlSource = 'flag' | 'env' | 'default';

export interface DevnetPricingUrl {
  /** The validated base URL (no trailing slash), or null for the harness's default stub. */
  url: string | null;
  source: DevnetPricingUrlSource;
}

function validate(raw: string, where: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${where} is not a URL: ${JSON.stringify(raw)} (want e.g. http://127.0.0.1:8790)`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${where} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${where} is a base URL: no query or fragment, got ${JSON.stringify(raw)}`);
  }
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, ''));
}

/**
 * Read `--pricing-url <url>` (or `--pricing-url=<url>`) out of argv (process.argv.slice(2)),
 * falling back to env.PRICING_URL. A flag without a value, an unknown `--pricing-*` flag and an
 * invalid URL are usage errors; every other argument is left for the harness.
 */
export function resolveDevnetPricingUrl(argv: readonly string[], env: { PRICING_URL?: string | undefined }): DevnetPricingUrl {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--pricing-url') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--pricing-url needs a value, e.g. --pricing-url http://127.0.0.1:8790');
      return { url: validate(value, '--pricing-url'), source: 'flag' };
    }
    if (arg.startsWith('--pricing-url=')) {
      const value = arg.slice('--pricing-url='.length);
      if (value === '') throw new Error('--pricing-url needs a value, e.g. --pricing-url=http://127.0.0.1:8790');
      return { url: validate(value, '--pricing-url'), source: 'flag' };
    }
    if (arg.startsWith('--pricing-')) throw new Error(`unknown flag ${JSON.stringify(arg)}; did you mean --pricing-url?`);
  }
  const fromEnv = env.PRICING_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { url: validate(fromEnv.trim(), 'PRICING_URL'), source: 'env' };
  return { url: null, source: 'default' };
}
