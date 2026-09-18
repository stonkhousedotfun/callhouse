/**
 * The v2 mode names, the switch's one question ("is V2_MODE set?"), and what a started mode hands
 * back. No imports: src/index.ts reads this before it knows whether to load v1 or v2, and the v1
 * path must not evaluate a single v2 module on the way.
 */

export const V2_MODES = ['cranker', 'pricing', 'mm', 'pricer'] as const;
export type V2Mode = (typeof V2_MODES)[number];
/** The modes that hold a key and send transactions. */
export type SigningMode = Exclude<V2Mode, 'pricing'>;

/**
 * V2_MODE as the switch reads it: undefined when unset or blank, which keeps the process on the v1
 * keeper (config.ts treats a blank value as unset too, and `.env` files ship `KEY=` lines). Any
 * other value, valid or not, selects v2, whose config then refuses a name it does not know: a typo
 * must not quietly boot the v1 keeper, which would exit asking for VAULT/FACTORY instead.
 */
export function requestedV2Mode(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.V2_MODE;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** A mode that is up. `close()` finishes in-flight work (a tick mid-transaction) before it resolves. */
export interface RunningMode {
  mode: V2Mode;
  /** The bound HTTP port (health for signing modes, the API for pricing), or null. */
  port: number | null;
  close(): Promise<void>;
  /** Signing modes: run the loop's next tick now (a devnet harness after a warp). */
  wake?(): void;
}

/** Thrown by a mode entry whose task has not landed. index.ts turns it into a clear exit. */
export class ModeNotImplementedError extends Error {
  constructor(
    readonly mode: V2Mode,
    /** The board task that builds it, e.g. K2-03. */
    readonly task: string,
  ) {
    super(`V2_MODE=${mode} is not implemented yet (${task} builds it)`);
    this.name = 'ModeNotImplementedError';
  }
}
