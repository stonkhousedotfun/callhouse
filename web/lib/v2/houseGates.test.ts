/**
 * (measured on a v9 fork): the House Cancel buttons were clickable with nothing queued and answered with
 * the shared BadUnits copy ("Enter a positive quantity"). Each gate here mirrors one HouseVault.sol refusal
 * (lib/v2/houseGates.ts cites them); each test names the refusal it mirrors.
 */
import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

// The click reads SETTLEMENT_WINDOW() from the registry's SettlementOracle; pin that address.
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  requireV2Address: (key: string) => key === "settlementOracle"
    ? "0x0000000000000000000000000000000000000077" : "0x0000000000000000000000000000000000000001",
}));

import {
  assertHouseGate, houseCancelDepositGate, houseCancelWithdrawGate, houseDepositGate, houseGateLine, houseWithdrawGate,
  readHouseGateState, HOUSE_DEPOSIT_CANCEL_CLOSED, HOUSE_DEPOSIT_PRICED, HOUSE_DEPOSIT_TO_CLAIM, HOUSE_DEPOSITS_CLOSED,
  HOUSE_NO_DEPOSIT_QUEUED, HOUSE_NO_WITHDRAWAL_QUEUED, HOUSE_REQUESTS_UNKNOWN, HOUSE_REQUESTS_UNREAD, HOUSE_WITHDRAWAL_CANCEL_CLOSED,
  HOUSE_WITHDRAWAL_PRICED, HOUSE_WITHDRAWAL_TO_CLAIM, HOUSE_WITHDRAWALS_CLOSED, houseDepositCancelQueueClosed,
  houseDepositQueueClosed, houseWithdrawCancelQueueClosed, houseWithdrawQueueClosed, type HouseGateState,
} from "./houseGates";
import { houseWindowWords } from "./houseEpoch";

const END = 1_790_000_000;
/** A test fixture for the chain's SETTLEMENT_WINDOW() read; the gates take the window as read, never a literal of their own. */
const W = 1_800;
/** The queue cutoff: HouseVault._requireBeforeCutoff refuses once `now + SETTLEMENT_WINDOW >= epochEnd`. */
const CUT = END - W;
const EMPTY_D = { epochId: 0n, usdg: 0n, stock: 0n };
const EMPTY_W = { epochId: 0n, shares: 0n };
/** Epoch 12, an hour before its end, nothing queued, 5 shares held. */
const state = (over: Partial<HouseGateState> = {}): HouseGateState => ({
  epochId: 12n, epochEnd: END, now: END - 3_600, balance: 5n * 10n ** 18n, settlementWindow: W,
  depositRequest: EMPTY_D, withdrawRequest: EMPTY_W, ...over,
});
const fmt = (raw: bigint) => (Number(raw) / 1e18).toString();
const reason = (gate: ReturnType<typeof houseDepositGate>) => (gate.open ? null : gate.reason);

describe("new deposit (requestDeposit / depositNow)", () => {
  it("PastCutoff: shut at and after epochEnd, on either path", () => {
    for (const instant of [false, true]) {
      expect(reason(houseDepositGate(state({ now: END }), instant))).toBe(HOUSE_DEPOSITS_CLOSED);
      expect(reason(houseDepositGate(state({ now: END + 600 }), instant))).toBe(HOUSE_DEPOSITS_CLOSED);
    }
    expect(houseDepositGate(state({ now: END - 1 }), true).open).toBe(true);
  });

  it("edge: the QUEUE is offered a second before epochEnd - SETTLEMENT_WINDOW and refused at it, with the copy", () => {
    expect(houseDepositGate(state({ now: CUT - 1 }), false).open).toBe(true);
    const at = houseDepositGate(state({ now: CUT }), false);
    expect(reason(at)).toBe(houseDepositQueueClosed(W));
    expect(houseGateLine(at)).toBe("Queued deposits stop 30 minutes before the close and reopen when the vault starts its next epoch.");
    expect(reason(houseDepositGate(state({ now: END - 1 }), false))).toBe(houseDepositQueueClosed(W));
  });

  it("depositNow keeps its own cutoff at epochEnd, so it stays open inside the window", () => {
    expect(houseDepositGate(state({ now: CUT }), true).open).toBe(true);
    expect(houseDepositGate(state({ now: END - 1 }), true).open).toBe(true);
  });

  it("an unread window shuts the queue only at the close; the chain refuses the window itself", () => {
    expect(houseDepositGate(state({ now: CUT, settlementWindow: null }), false).open).toBe(true);
    expect(reason(houseDepositGate(state({ now: END, settlementWindow: null }), false))).toBe(HOUSE_DEPOSITS_CLOSED);
  });

  it("the window is the one read, not a literal: a different window moves the edge", () => {
    expect(houseDepositGate(state({ now: END - 601, settlementWindow: 600 }), false).open).toBe(true);
    expect(reason(houseDepositGate(state({ now: END - 600, settlementWindow: 600 }), false))).toBe(houseDepositQueueClosed(600));
    expect(houseWindowWords(600)).toBe("10 minutes");
    expect(houseWindowWords(60)).toBe("1 minute");
    expect(houseWindowWords(90)).toBe("90 seconds");
  });

  it("TooEarly: an unclaimed deposit from an older epoch shuts the QUEUE, not depositNow (which never touches it)", () => {
    const older = state({ depositRequest: { epochId: 11n, usdg: 5_000_000n, stock: 0n } });
    expect(reason(houseDepositGate(older, false))).toBe(HOUSE_DEPOSIT_TO_CLAIM);
    expect(houseDepositGate(older, true).open).toBe(true);
    // A stock-only older request counts too; a request of THIS epoch is topped up, not refused.
    expect(reason(houseDepositGate(state({ depositRequest: { epochId: 11n, usdg: 0n, stock: 1n } }), false))).toBe(HOUSE_DEPOSIT_TO_CLAIM);
    expect(houseDepositGate(state({ depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } }), false).open).toBe(true);
  });

  it("unknown is not a refusal for a new request: unread or failed reads and an unknown clock leave it to the chain", () => {
    expect(houseDepositGate(state({ epochId: undefined, depositRequest: undefined }), false).open).toBe(true);
    expect(houseDepositGate(state({ epochId: null, depositRequest: null }), false).open).toBe(true);
    expect(houseDepositGate(state({ now: null }), false).open).toBe(true);
    expect(houseDepositGate(state({ epochEnd: null }), false).open).toBe(true);
  });
});

describe("cancel a queued deposit (cancelDepositRequest)", () => {
  it("BadUnits: shut with nothing queued, and quiet (the page adds no line)", () => {
    const gate = houseCancelDepositGate(state());
    expect(reason(gate)).toBe(HOUSE_NO_DEPOSIT_QUEUED);
    expect(houseGateLine(gate)).toBeNull();
  });

  it("control: open with a deposit queued THIS epoch before its end", () => {
    expect(houseCancelDepositGate(state({ depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } })).open).toBe(true);
    expect(houseCancelDepositGate(state({ depositRequest: { epochId: 12n, usdg: 0n, stock: 3n } })).open).toBe(true);
  });

  it("TooEarly: a deposit from an older epoch was priced; claim it instead, with a line", () => {
    const gate = houseCancelDepositGate(state({ depositRequest: { epochId: 11n, usdg: 5_000_000n, stock: 0n } }));
    expect(reason(gate)).toBe(HOUSE_DEPOSIT_PRICED);
    expect(houseGateLine(gate)).toBe(HOUSE_DEPOSIT_PRICED);
  });

  it("PastCutoff edge: open a second before epochEnd - SETTLEMENT_WINDOW, shut at it with the copy, and at epochEnd until the vault rolls", () => {
    const queued = { depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } };
    expect(houseCancelDepositGate(state({ ...queued, now: CUT - 1 })).open).toBe(true);
    expect(reason(houseCancelDepositGate(state({ ...queued, now: CUT })))).toBe(houseDepositCancelQueueClosed(W));
    expect(houseGateLine(houseCancelDepositGate(state({ ...queued, now: CUT }))))
      .toBe("Cancels stop 30 minutes before the close, so this deposit is priced at the close.");
    expect(reason(houseCancelDepositGate(state({ ...queued, now: END })))).toBe(HOUSE_DEPOSIT_CANCEL_CLOSED);
  });

  it("fails closed on an unread (quiet) or failed (with a line) read", () => {
    const unread = houseCancelDepositGate(state({ depositRequest: undefined }));
    expect(reason(unread)).toBe(HOUSE_REQUESTS_UNREAD);
    expect(houseGateLine(unread)).toBeNull();
    const failed = houseCancelDepositGate(state({ epochId: null }));
    expect(reason(failed)).toBe(HOUSE_REQUESTS_UNKNOWN);
    expect(houseGateLine(failed)).toBe(HOUSE_REQUESTS_UNKNOWN);
  });
});

describe("new withdrawal (requestWithdraw)", () => {
  // A contract change reversed the rule this block used to pin ("has NO cutoff on chain, so none here: open after epochEnd").
  it("PastCutoff edge: open a second before epochEnd - SETTLEMENT_WINDOW, shut at it with the copy, and after epochEnd", () => {
    expect(houseWithdrawGate(state({ now: CUT - 1 }), 10n ** 18n, fmt).open).toBe(true);
    const at = houseWithdrawGate(state({ now: CUT }), 10n ** 18n, fmt);
    expect(reason(at)).toBe(houseWithdrawQueueClosed(W));
    expect(houseGateLine(at)).toBe("Withdrawal requests stop 30 minutes before the close and reopen when the vault starts its next epoch.");
    expect(reason(houseWithdrawGate(state({ now: END + 600 }), 10n ** 18n, fmt))).toBe(HOUSE_WITHDRAWALS_CLOSED);
    // No amount entered yet: the line still shows, so the user knows why before typing.
    expect(reason(houseWithdrawGate(state({ now: CUT }), null, fmt))).toBe(houseWithdrawQueueClosed(W));
  });

  it("TooEarly: an unclaimed withdrawal from an older epoch shuts it; this epoch's is topped up", () => {
    expect(reason(houseWithdrawGate(state({ withdrawRequest: { epochId: 11n, shares: 1n } }), 10n ** 18n, fmt)))
      .toBe(HOUSE_WITHDRAWAL_TO_CLAIM);
    expect(houseWithdrawGate(state({ withdrawRequest: { epochId: 12n, shares: 1n } }), 10n ** 18n, fmt).open).toBe(true);
  });

  it("caps the amount at the shares held (the shares leave the wallet), with the balance in the line", () => {
    expect(reason(houseWithdrawGate(state(), 5n * 10n ** 18n + 1n, fmt))).toBe("You hold 5 shares. Enter that many or fewer.");
    expect(houseWithdrawGate(state(), 5n * 10n ** 18n, fmt).open).toBe(true);
    // No amount entered yet, or the balance not read: no cap to apply.
    expect(houseWithdrawGate(state(), null, fmt).open).toBe(true);
    expect(houseWithdrawGate(state({ balance: null }), 10n ** 30n, fmt).open).toBe(true);
    expect(houseWithdrawGate(state({ balance: undefined }), 10n ** 30n, fmt).open).toBe(true);
  });
});

describe("cancel a queued withdrawal (cancelWithdrawRequest)", () => {
  it("BadUnits: shut and quiet with nothing queued; open with one queued this epoch", () => {
    const none = houseCancelWithdrawGate(state());
    expect(reason(none)).toBe(HOUSE_NO_WITHDRAWAL_QUEUED);
    expect(houseGateLine(none)).toBeNull();
    expect(houseCancelWithdrawGate(state({ withdrawRequest: { epochId: 12n, shares: 1n } })).open).toBe(true);
  });

  it("TooEarly: a withdrawal from an older epoch was processed; claim it instead", () => {
    expect(reason(houseCancelWithdrawGate(state({ withdrawRequest: { epochId: 11n, shares: 1n } })))).toBe(HOUSE_WITHDRAWAL_PRICED);
  });

  // A contract change reversed the rule this block used to pin ("has NO cutoff on chain, so none here").
  it("PastCutoff edge: open a second before epochEnd - SETTLEMENT_WINDOW, shut at it with the copy, and after epochEnd", () => {
    const queued = { withdrawRequest: { epochId: 12n, shares: 1n } };
    expect(houseCancelWithdrawGate(state({ ...queued, now: CUT - 1 })).open).toBe(true);
    expect(reason(houseCancelWithdrawGate(state({ ...queued, now: CUT })))).toBe(houseWithdrawCancelQueueClosed(W));
    expect(reason(houseCancelWithdrawGate(state({ ...queued, now: END + 600 })))).toBe(HOUSE_WITHDRAWAL_CANCEL_CLOSED);
    // Nothing queued stays the quiet reason (BadUnits comes first on chain), and a processed one says claim it.
    expect(reason(houseCancelWithdrawGate(state({ now: CUT })))).toBe(HOUSE_NO_WITHDRAWAL_QUEUED);
    expect(reason(houseCancelWithdrawGate(state({ withdrawRequest: { epochId: 11n, shares: 1n }, now: CUT })))).toBe(HOUSE_WITHDRAWAL_PRICED);
  });

  it("fails closed on an unread or failed read", () => {
    expect(reason(houseCancelWithdrawGate(state({ withdrawRequest: undefined })))).toBe(HOUSE_REQUESTS_UNREAD);
    expect(reason(houseCancelWithdrawGate(state({ withdrawRequest: null })))).toBe(HOUSE_REQUESTS_UNKNOWN);
  });
});

describe("the click re-reads the chain at one block", () => {
  const ORACLE = "0x0000000000000000000000000000000000000077";
  const vault = "0x0000000000000000000000000000000000000066";
  const account = "0x0000000000000000000000000000000000000044";

  it("reads the request state for this account at the latest block, with that block's timestamp as now", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => ({
      epochId: 12n, epochEnd: END, withdrawRequestOf: [11n, 7n], depositRequestOf: [12n, 5n, 0n], balanceOf: 9n,
      SETTLEMENT_WINDOW: W,
    })[functionName]);
    const client = { getBlock: vi.fn(async () => ({ number: 77n, timestamp: BigInt(END - 5) })), readContract } as unknown as PublicClient;
    expect(await readHouseGateState(vault, account, client)).toEqual({
      epochId: 12n, epochEnd: END, now: END - 5, balance: 9n, settlementWindow: W,
      withdrawRequest: { epochId: 11n, shares: 7n }, depositRequest: { epochId: 12n, usdg: 5n, stock: 0n },
    });
    // Every vault fact at that block, and the window from the registry's SettlementOracle at the same block.
    for (const [request] of readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 77n });
    for (const [request] of readContract.mock.calls.filter(([r]) => r.functionName !== "SETTLEMENT_WINDOW"))
      expect(request).toMatchObject({ address: vault });
    expect(readContract.mock.calls.find(([r]) => r.functionName === "SETTLEMENT_WINDOW")![0])
      .toMatchObject({ address: ORACLE });
    for (const name of ["withdrawRequestOf", "depositRequestOf", "balanceOf"])
      expect(readContract.mock.calls.find(([r]) => r.functionName === name)![0]).toMatchObject({ args: [account] });
  });

  it("a failed read throws rather than guessing", async () => {
    const client = { getBlock: vi.fn(async () => ({ number: 1n, timestamp: 1n })),
      readContract: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as PublicClient;
    await expect(readHouseGateState(vault, account, client)).rejects.toThrow("Could not check the vault before sending.");
  });

  it("assertHouseGate throws the gate's own line, quiet or not, and passes an open gate", () => {
    expect(() => assertHouseGate(houseCancelDepositGate(state()))).toThrow(HOUSE_NO_DEPOSIT_QUEUED);
    expect(() => assertHouseGate(houseDepositGate(state({ now: END }), true))).toThrow(HOUSE_DEPOSITS_CLOSED);
    expect(() => assertHouseGate({ open: true })).not.toThrow();
  });
});
