/**
 * The poll loop of a v2 mode, as v1's main-v1.ts runs it: the first tick at once, the next one
 * `intervalMs` after the previous one FINISHED (never overlapping, however slow a tick is), and a
 * stop that lets the in-flight tick finish, because a half-sent transaction is worse than a slow
 * exit.
 *
 * A tick that throws does not end the loop: the next tick re-reads everything from chain, and every
 * step is idempotent, so this tick's work is either done or not, never half-done. `onError` decides
 * what to log and page.
 *
 * `wake()` runs the next tick now instead of at the end of the interval. A wake that arrives while
 * a tick is in flight is remembered: the next tick starts as soon as that one finishes, not an
 * interval later. The cranker's precise wake-up at an expiry builds on this: a tick that began a
 * second before the expiry read a pre-expiry chain, so its successor must not wait a poll interval.
 */

export interface LoopOptions {
  intervalMs: number;
  tick: () => Promise<void>;
  onError: (error: unknown) => Promise<void> | void;
}

export interface RunningLoop {
  /** Run the next tick now (or right after the in-flight one). */
  wake(): void;
  /** No further ticks; resolves once the in-flight tick (if any) has finished. */
  stop(): Promise<void>;
}

export function startLoop(options: LoopOptions): RunningLoop {
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let wakePending = false;

  const run = (): void => {
    if (stopping) return;
    if (inFlight !== null) {
      wakePending = true;
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    wakePending = false;
    inFlight = (async () => {
      try {
        await options.tick();
      } catch (error) {
        try {
          await options.onError(error);
        } catch {
          // An error handler that throws must not kill the loop either.
        }
      }
    })().finally(() => {
      inFlight = null;
      if (stopping) return;
      if (wakePending) {
        wakePending = false;
        // A macrotask, not a direct call: the finished tick's promise chain settles first.
        timer = setTimeout(run, 0);
      } else {
        timer = setTimeout(run, options.intervalMs);
      }
    });
  };

  run();

  return {
    wake: run,
    async stop() {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (inFlight !== null) await inFlight;
    },
  };
}
