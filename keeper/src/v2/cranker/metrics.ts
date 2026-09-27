/**
 * Per-step metrics for the cranker's /state: how often each
 * step ran, how long it took, what it sent and what came back, its last error, and what its last
 * run saw (the step's notes: expiries and their phase, ladder plans, redeem counts, roll decisions).
 * In memory: /state describes this process; the durable record of every transaction is v2_txs.
 */
import type { RaisedAlert } from './effects.js';
import { STEP_ORDER, type ActionRecord, type StepName, type StepReport } from './steps.js';

export interface StepMetrics {
  runs: number;
  errors: number;
  lastStartedAt: string | null;
  lastDurationMs: number | null;
  /** Head block timestamp the last run started at. */
  lastHeadTimestamp: number | null;
  lastError: { at: string; message: string } | null;
  /** Outcome status → count, since boot. */
  outcomes: Record<string, number>;
  lastActions: ActionRecord[];
  lastNotes: Record<string, unknown>;
}

const MAX_ACTIONS = 50;
const MAX_ALERTS = 30;

const emptyStep = (): StepMetrics => ({
  runs: 0,
  errors: 0,
  lastStartedAt: null,
  lastDurationMs: null,
  lastHeadTimestamp: null,
  lastError: null,
  outcomes: {},
  lastActions: [],
  lastNotes: {},
});

/**
 * The firstmint step since boot: expiries it pinned with a one-unit take, and the USDG base units it spent.
 * The day's spend against FIRST_MINT_DAILY_CAP is in the step's lastNotes (`spent`, `cap`); the durable count is store
 * meta (firstmint.ts firstMintSpentMetaKey).
 */
export interface FirstMintMetrics {
  pinned: number;
  spent: string;
}

export class CrankerMetrics {
  readonly steps: Record<StepName, StepMetrics>;
  readonly firstMint: FirstMintMetrics = { pinned: 0, spent: '0' };
  ticks = 0;
  lastTickAt: string | null = null;
  lastTickDurationMs: number | null = null;
  recentAlerts: Array<RaisedAlert & { at: string }> = [];

  constructor() {
    this.steps = Object.fromEntries(STEP_ORDER.map((s) => [s, emptyStep()])) as Record<StepName, StepMetrics>;
  }

  recordStep(report: StepReport, startedAtMs: number, durationMs: number, headTimestamp: number | null): void {
    const m = this.steps[report.step];
    m.runs += 1;
    m.lastStartedAt = new Date(startedAtMs).toISOString();
    m.lastDurationMs = durationMs;
    m.lastHeadTimestamp = headTimestamp;
    for (const a of report.actions) m.outcomes[a.status] = (m.outcomes[a.status] ?? 0) + 1;
    m.lastActions = report.actions.slice(-MAX_ACTIONS);
    m.lastNotes = report.notes;
    if (report.step === 'firstmint') {
      const { pinnedThisTick, spentThisTick } = report.notes;
      if (typeof pinnedThisTick === 'number') this.firstMint.pinned += pinnedThisTick;
      if (typeof spentThisTick === 'string' && /^\d+$/.test(spentThisTick)) this.firstMint.spent = (BigInt(this.firstMint.spent) + BigInt(spentThisTick)).toString();
    }
  }

  recordStepError(step: StepName, startedAtMs: number, durationMs: number, message: string): void {
    const m = this.steps[step];
    m.runs += 1;
    m.errors += 1;
    m.lastStartedAt = new Date(startedAtMs).toISOString();
    m.lastDurationMs = durationMs;
    m.lastError = { at: new Date(startedAtMs + durationMs).toISOString(), message };
  }

  recordTick(startedAtMs: number, durationMs: number, alerts: readonly RaisedAlert[]): void {
    this.ticks += 1;
    this.lastTickAt = new Date(startedAtMs).toISOString();
    this.lastTickDurationMs = durationMs;
    const at = new Date(startedAtMs + durationMs).toISOString();
    this.recentAlerts = [...alerts.map((a) => ({ ...a, at })), ...this.recentAlerts].slice(0, MAX_ALERTS);
  }
}
