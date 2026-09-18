/**
 * The cranker's two side effects, each behind a port so the dry run can swap it:
 *
 *   CrankSender  live: tx.ts's TxSender (in flight? → advanced? → simulate → worth it? → send → journal
 *                → wait). dry: the same judgement up to the simulation, then `would-send`; nothing is
 *                signed, broadcast or journalled.
 *   CrankAlerts  live: alerts.ts's Alerter, plus "once ever" for events (a missed snapshot, a new
 *                disagreeing candidate) remembered in v2_meta once DELIVERED so a restart does not page again
 *                (a failed delivery is raised again by a later tick, at most every five minutes).
 *                dry: collected for the report.
 */
import type { Abi, Address, PublicClient } from 'viem';
import { FAILED_DELIVERY_RETRY_MS, type AlertSeverity, type Alerter, type V2AlertKind } from '../alerts.js';
import type { V2Store } from '../store.js';
import { simulationReverted, type ExecuteOptions, type TxOutcome, type TxSender, type WriteCall, type WriteFunctionName } from '../tx.js';

/*//////////////////////////////////////////////////////////////
                              SENDER
//////////////////////////////////////////////////////////////*/

export type CrankOutcome = TxOutcome | { status: 'would-send'; result: unknown };

/** A write with its fixed gas limit (constants.ts GAS): never estimated. */
export type FixedGasCall<TAbi extends Abi = Abi, TName extends WriteFunctionName<TAbi> = WriteFunctionName<TAbi>> = WriteCall<TAbi, TName> & { gas: bigint };

export interface CrankSender {
  readonly dryRun: boolean;
  readonly account: Address;
  execute(call: FixedGasCall, options: ExecuteOptions<unknown>): Promise<CrankOutcome>;
}

export function liveSender(sender: TxSender): CrankSender {
  return {
    dryRun: false,
    account: sender.account,
    execute: (call, options) => sender.execute(call as never, options as never),
  };
}

/** Simulates as `account` against the public client; never signs. */
export function drySender(publicClient: Pick<PublicClient, 'simulateContract'>, account: Address): CrankSender {
  return {
    dryRun: true,
    account,
    async execute(call, options) {
      if (options.isAdvanced !== undefined && (await options.isAdvanced())) return { status: 'already-advanced' };
      let result: unknown;
      try {
        ({ result } = await publicClient.simulateContract({ ...call, account } as never));
      } catch (error) {
        return simulationReverted(error);
      }
      if (options.worthSending !== undefined && !options.worthSending(result)) return { status: 'no-op', result };
      return { status: 'would-send', result };
    },
  };
}

/** Whether an outcome changed (or, dry, would change) the chain. */
export const advanced = (o: CrankOutcome): o is Extract<CrankOutcome, { status: 'confirmed' | 'would-send' }> => o.status === 'confirmed' || o.status === 'would-send';

/*//////////////////////////////////////////////////////////////
                              ALERTS
//////////////////////////////////////////////////////////////*/

export interface RaisedAlert {
  kind: V2AlertKind;
  dedupeKey: string;
  message: string;
  data: Record<string, unknown>;
  once: boolean;
  /** Overrides the kind's ALERT_SEVERITY for this occurrence (one condition, two P-levels by cause). */
  severity?: AlertSeverity;
}

export const ALERTED_META_PREFIX = 'cranker:alerted:';

export class CrankAlerts {
  /** Every alert raised since the last drain (the dry-run report, /state). */
  private raised: RaisedAlert[] = [];
  /** Once-ever events whose delivery failed, by meta key: retried no sooner than FAILED_DELIVERY_RETRY_MS later. */
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly alerter: Pick<Alerter, 'alert' | 'clear'> | null,
    private readonly store: V2Store,
    private readonly dryRun: boolean,
    /** SEAM: wall clock, ms (the retry spacing of a failed delivery). */
    private readonly now: () => number = Date.now,
  ) {}

  async raise(alert: RaisedAlert): Promise<void> {
    if (alert.once) {
      const key = `${ALERTED_META_PREFIX}${alert.kind}:${alert.dedupeKey}`;
      if (this.store.getMeta(key) !== null) return;
      this.raised.push(alert);
      if (this.dryRun || this.alerter === null) return;
      // The alerter redelivers a failed page from its stored row (alerts.ts redeliver), also across a restart:
      // delivered that way, it is remembered, not paged twice.
      if (this.store.alertDeliveredSince(alert.kind, alert.dedupeKey, 0)) {
        this.failedAt.delete(key);
        this.store.setMeta(key, String(Math.floor(this.now() / 1000)));
        return;
      }
      const failed = this.failedAt.get(key);
      if (failed !== undefined && this.now() - failed < FAILED_DELIVERY_RETRY_MS) return;
      // Remembered only once the relay took it: a page that never arrived is raised again by a later tick.
      if (await this.alerter.alert(alert.kind, alert.message, alert.data, { dedupeKey: alert.dedupeKey, force: true, ...(alert.severity === undefined ? {} : { severity: alert.severity }) })) {
        this.failedAt.delete(key);
        this.store.setMeta(key, String(Math.floor(this.now() / 1000)));
      } else {
        this.failedAt.set(key, this.now());
      }
      return;
    }
    this.raised.push(alert);
    if (this.dryRun || this.alerter === null) return;
    await this.alerter.alert(alert.kind, alert.message, alert.data, { dedupeKey: alert.dedupeKey, ...(alert.severity === undefined ? {} : { severity: alert.severity }) });
  }

  clear(kind: V2AlertKind, dedupeKey: string): void {
    this.alerter?.clear(kind, dedupeKey);
  }

  drain(): RaisedAlert[] {
    const out = this.raised;
    this.raised = [];
    return out;
  }
}
