/**
 * One cranker tick: the steps of steps.ts in order, each isolated (a step that throws is recorded,
 * paged as `v2_error` once per cooldown per step, and the next step runs), then the precise wake-up.
 *
 * THE ANCHOR. Once per process, before the first step: the deployment anchor (../anchor.ts) against
 * the index's; a store written for another deployment at the same addresses is reset first. A tick
 * that cannot read it fails whole (the loop pages v2_error) and the next one retries: no step runs on
 * a store nobody has matched to the chain.
 *
 * THE WAKE-UP. Every step reports the head timestamps at which it has time-critical work (an expiry
 * with open interest: its snapshot; expiry + 120: the first finalize; a candidate's finalizableAt).
 * planner.scheduleWake turns the earliest into a timer when it comes before the next poll, and the
 * timer calls the loop's wake() (loop.ts runs it right after an in-flight tick). The delay is
 * measured on the head block's clock, plus a margin, so a tick woken at an expiry reads a head at or
 * past it; a head that has not got there yet re-arms a short timer.
 */
import type { Address } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { anchorWarning, readDeploymentAnchor } from '../anchor.js';
import { readHead, type Head } from '../chain.js';
import { describeError } from '../tx.js';
import { expiryKeyString, scheduleWake, selectExpiries, yieldDeadlineMs, type ExpiryKey, type WakeSchedule } from './planner.js';
import { CrankerMetrics } from './metrics.js';
import type { RaisedAlert } from './effects.js';
import { stepFlywheel } from './flywheel.js';
import {
  STEP_ORDER,
  stepFinalize,
  stepHousekeeping,
  stepIndex,
  stepLadders,
  stepPrune,
  stepRedeem,
  stepRolls,
  stepSettle,
  stepSnapshot,
  stepStale,
  type CrankContext,
  type StepName,
  type StepReport,
} from './steps.js';

/** Expiries surveyed per tick at most (recent ones first, then the older backlog in rotation; done ones drop out). */
export const MAX_EXPIRIES_PER_TICK = 200;
/**
 * Expiries at most this old are "recent" (planner.selectExpiries): surveyed before any older backlog. Three days
 * covers the snapshot and finalize windows, the uncorroborated delay, a veto and adminResolve (expiry + 48 h).
 */
export const RECENT_EXPIRY_S = 3 * 86_400;

export interface TickReport {
  head: Head | null;
  expiries: string[];
  reports: StepReport[];
  errors: Array<{ step: StepName; message: string }>;
  alerts: RaisedAlert[];
  wake: WakeSchedule | null;
}

export interface CrankerOptions {
  pollIntervalMs: number;
  /** false for the dry run: no timers. */
  schedule: boolean;
  /** Wall clock for metrics only. */
  now?: () => number;
}

export class Cranker {
  readonly metrics = new CrankerMetrics();
  private wakeLoop: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scheduled: WakeSchedule | null = null;
  private usdg: Address | null;
  private lastHead: Head | null = null;
  private lastHeadReadAt = 0;
  private stopped = false;
  private anchored: Promise<void> | null = null;
  /** Where the next tick's slice of the old-expiry backlog starts (planner.selectExpiries). */
  private backlogOffset = 0;
  private readonly now: () => number;

  constructor(
    readonly ctx: CrankContext,
    private readonly options: CrankerOptions,
  ) {
    this.usdg = ctx.config.registry.usdg;
    this.now = options.now ?? Date.now;
  }

  bindLoop(loop: { wake(): void }): void {
    this.wakeLoop = () => loop.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.scheduled = null;
  }

  /** The expiries worth surveying now: expired and not done, or due within the horizon. */
  private horizonS(): number {
    return Math.max(900, Math.ceil(this.options.pollIntervalMs / 1000) * 2);
  }

  private async run(step: StepName, fn: () => Promise<StepReport>, into: TickReport): Promise<void> {
    const started = this.now();
    try {
      const report = await fn();
      into.reports.push(report);
      this.metrics.recordStep(report, started, this.now() - started, this.lastHead?.timestamp ?? null);
      for (const a of report.actions) {
        this.ctx.log.info({ step, status: a.status, kind: a.kind, key: a.key, hash: a.hash, revert: a.revert }, a.what);
      }
    } catch (error) {
      const message = describeError(error);
      into.errors.push({ step, message });
      this.metrics.recordStepError(step, started, this.now() - started, message);
      this.ctx.log.error({ step, err: message }, 'cranker step failed');
      await this.ctx.alerts.raise({ kind: 'v2_error', dedupeKey: `cranker:${step}`, once: false, message: `cranker step ${step} failed: ${message}`, data: { step, reason: message } });
    }
  }

  /** Once per process: reset the index if it describes another deployment at these addresses. */
  private bindAnchor(): Promise<void> {
    this.anchored ??= (async () => {
      const anchor = await readDeploymentAnchor(this.ctx.client, this.ctx.config.registry.deployBlock);
      const recorded = this.ctx.index.anchor();
      const check = this.ctx.index.bindAnchor(anchor);
      const warning = anchorWarning(check, 'the cranker index');
      if (warning !== null) this.ctx.log.warn({ check, anchor, recorded, db: this.ctx.store.path }, `${warning}${check === 'unanchored' ? '' : ' (rescans from the deploy block; snapshot, settlement, ladder, sweep and alert marks cleared; pending journal rows dropped)'}`);
      else this.ctx.log.info({ check, anchor }, 'cranker index bound to the deployment anchor');
    })().catch((error: unknown) => {
      this.anchored = null;
      throw error;
    });
    return this.anchored;
  }

  async tick(): Promise<TickReport> {
    const started = this.now();
    const report: TickReport = { head: null, expiries: [], reports: [], errors: [], alerts: [], wake: null };
    const ctx = this.ctx;
    await this.bindAnchor();

    await this.run('index', () => stepIndex(ctx), report);

    let keys: ExpiryKey[] = [];
    try {
      this.lastHead = await readHead(ctx.client);
      this.lastHeadReadAt = this.now();
      report.head = this.lastHead;
      const now = this.lastHead.timestamp;
      keys = selectExpiries(ctx.index.expiries(), ctx.index.doneExpiries(), now, this.horizonS(), MAX_EXPIRIES_PER_TICK, { recentS: RECENT_EXPIRY_S, backlogOffset: this.backlogOffset });
      this.backlogOffset += keys.filter((k) => k.expiry < now - RECENT_EXPIRY_S).length;
      report.expiries = keys.map(expiryKeyString);
    } catch (error) {
      report.errors.push({ step: 'index', message: `head read failed: ${describeError(error)}` });
    }

    for (const step of STEP_ORDER) {
      switch (step) {
        case 'index':
          break;
        case 'stale':
          await this.run(step, () => stepStale(ctx), report);
          break;
        case 'snapshot':
          await this.run(step, () => stepSnapshot(ctx, keys), report);
          break;
        case 'finalize': {
          await this.run(step, () => stepFinalize(ctx, keys), report);
          // Past the earliest time-critical target the snapshot and finalize steps planned, the slow steps stop sending.
          const deadline = this.lastHead === null ? null : yieldDeadlineMs({ targets: report.reports.flatMap((r) => r.wakeAt), headTimestamp: this.lastHead.timestamp, headReadAtMs: this.lastHeadReadAt });
          ctx.yieldWhen = deadline === null ? undefined : () => this.now() >= deadline;
          break;
        }
        case 'settle':
          await this.run(step, () => stepSettle(ctx, keys), report);
          break;
        case 'prune':
          await this.run(step, () => stepPrune(ctx, keys), report);
          break;
        case 'redeem':
          await this.run(step, () => stepRedeem(ctx, keys), report);
          break;
        case 'ladders':
          await this.run(step, () => stepLadders(ctx), report);
          break;
        case 'rolls':
          await this.run(step, () => stepRolls(ctx), report);
          break;
        case 'housekeeping':
          await this.run(
            step,
            async () => {
              this.usdg ??= await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'usdg' });
              return stepHousekeeping(ctx, this.usdg);
            },
            report,
          );
          break;
        // Last, so the fees housekeeping just swept into the splitter are split in the same tick.
        case 'flywheel':
          await this.run(
            step,
            async () => {
              this.usdg ??= await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'usdg' });
              return stepFlywheel(ctx, this.usdg);
            },
            report,
          );
          break;
      }
    }

    ctx.yieldWhen = undefined;
    report.alerts = ctx.alerts.drain();
    this.metrics.recordTick(started, this.now() - started, report.alerts);
    if (this.options.schedule && this.lastHead !== null) report.wake = this.arm(report);
    return report;
  }

  /** Arm (or keep) the precise wake-up for the earliest time-critical target of this tick. */
  private arm(report: TickReport): WakeSchedule | null {
    if (this.stopped || this.lastHead === null) return null;
    // A tick takes time: measure the delay from the head as it is likely to be now.
    const elapsedS = Math.max(0, Math.floor((this.now() - this.lastHeadReadAt) / 1000));
    const schedule = scheduleWake({
      now: this.lastHead.timestamp + elapsedS,
      plannedAt: this.lastHead.timestamp,
      targets: report.reports.flatMap((r) => r.wakeAt),
      pollIntervalMs: this.options.pollIntervalMs,
    });
    if (schedule === null) return this.scheduled;
    if (this.timer !== null && this.scheduled !== null && this.scheduled.at <= schedule.at) return this.scheduled;
    if (this.timer !== null) clearTimeout(this.timer);
    this.scheduled = schedule;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduled = null;
      if (!this.stopped) this.wakeLoop?.();
    }, schedule.delayMs);
    this.ctx.log.info({ at: schedule.at, delayMs: schedule.delayMs }, 'precise wake-up armed');
    return schedule;
  }

  /** The /state body. */
  state(): unknown {
    const m = this.metrics;
    return {
      mode: 'cranker',
      dryRun: this.ctx.sender.dryRun,
      signer: this.ctx.sender.account,
      head: this.lastHead,
      ticks: m.ticks,
      lastTickAt: m.lastTickAt,
      lastTickDurationMs: m.lastTickDurationMs,
      wake: this.scheduled,
      contracts: this.ctx.addresses,
      indexer: this.ctx.config.indexerUrl === null ? null : new URL(this.ctx.config.indexerUrl).origin,
      index: { scannedTo: this.ctx.index.scannedTo(), ...this.ctx.index.counts() },
      steps: m.steps,
      recentAlerts: m.recentAlerts,
      recentTxs: this.ctx.store.recentTxs(20),
    };
  }
}
