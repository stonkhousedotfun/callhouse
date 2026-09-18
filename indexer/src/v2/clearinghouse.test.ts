import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { clearinghouseAbi } from "../../abis/v2/clearinghouse";
import {
  ZERO_ADDRESS,
  addNonnegative,
  balanceId,
  ledgerId,
  marketStatus,
  openInterestDelta,
  positionId,
  setAddressFlag,
  tenorFromWeekly,
  tickerFromSymbol,
  walletDeltas,
  type TokenTransfer,
} from "../../lib/v2/clearinghouse";

const writer = "0x1111111111111111111111111111111111111111" as Address;
const buyer = "0x2222222222222222222222222222222222222222" as Address;
const third = "0x3333333333333333333333333333333333333333" as Address;
const book = "0x4444444444444444444444444444444444444444" as Address;
const LONG = 100n;
const SHORT = 101n;

describe("v2 Clearinghouse reducers", () => {
  it("replays mint, escrow, resale, close, and redemption without double-counting short supply", () => {
    const wallets = new Map<string, bigint>();
    let interest = 0n;
    let escrowedLong = 0n;
    const replay = (input: TokenTransfer) => {
      for (const { holder, delta } of walletDeltas(input, book)) {
        const id = balanceId(input.tokenId, holder);
        wallets.set(id, addNonnegative(wallets.get(id) ?? 0n, delta, id));
      }
      if (input.tokenId === LONG && input.to === book) escrowedLong += input.units;
      if (input.tokenId === LONG && input.from === book) escrowedLong -= input.units;
      interest = addNonnegative(interest, openInterestDelta(input), "open interest");
    };
    const held = (id: bigint, holder: Address) => wallets.get(balanceId(id, holder)) ?? 0n;

    replay({ from: ZERO_ADDRESS, to: buyer, tokenId: LONG, units: 10n });
    replay({ from: ZERO_ADDRESS, to: writer, tokenId: SHORT, units: 10n });
    expect(interest).toBe(10n);
    expect(held(LONG, buyer)).toBe(10n);
    expect(held(SHORT, writer)).toBe(10n);

    replay({ from: buyer, to: book, tokenId: LONG, units: 4n });
    expect(held(LONG, buyer)).toBe(6n);
    expect(held(LONG, book)).toBe(0n);
    expect(escrowedLong).toBe(4n);
    expect(interest).toBe(10n);

    replay({ from: book, to: third, tokenId: LONG, units: 2n });
    replay({ from: book, to: buyer, tokenId: LONG, units: 2n });
    replay({ from: buyer, to: writer, tokenId: LONG, units: 3n });
    expect(escrowedLong).toBe(0n);
    expect([held(LONG, buyer), held(LONG, third), held(LONG, writer)]).toEqual([5n, 2n, 3n]);

    replay({ from: writer, to: ZERO_ADDRESS, tokenId: LONG, units: 3n });
    replay({ from: writer, to: ZERO_ADDRESS, tokenId: SHORT, units: 3n });
    expect(interest).toBe(7n);
    expect(held(SHORT, writer)).toBe(7n);

    replay({ from: buyer, to: ZERO_ADDRESS, tokenId: LONG, units: 5n });
    replay({ from: third, to: ZERO_ADDRESS, tokenId: LONG, units: 2n });
    replay({ from: writer, to: ZERO_ADDRESS, tokenId: SHORT, units: 7n });
    expect(interest).toBe(0n);
    expect([...wallets.values()].every((units) => units === 0n)).toBe(true);
  });

  it("classifies token sides and rejects missing transfer history", () => {
    expect(positionId(LONG)).toEqual({ longId: LONG, side: "long" });
    expect(positionId(SHORT)).toEqual({ longId: LONG, side: "short" });
    expect(walletDeltas({ from: buyer, to: buyer, tokenId: LONG, units: 1n }, book)).toEqual([]);
    expect(() => addNonnegative(2n, -3n, "wallet")).toThrow(/wallet underflow/);
    expect(() => walletDeltas({ from: buyer, to: book, tokenId: LONG, units: -1n }, book)).toThrow(/negative/);
  });

  it("normalizes account keys and keeps operator flags independent", () => {
    expect(ledgerId(buyer, writer)).toBe(`${buyer}-${writer}`);
    const afterApprove = setAddressFlag("{}", book, true);
    const afterRevoke = setAddressFlag(afterApprove, book, false);
    expect(JSON.parse(afterApprove)).toEqual({ [book]: true });
    expect(JSON.parse(afterRevoke)).toEqual({ [book]: false });
  });

  it("derives market display values without invented fallback tickers", () => {
    expect(tickerFromSymbol(" nvda ")).toBe("NVDA");
    expect(() => tickerFromSymbol("Tokenized NVIDIA Stock")).toThrow(/invalid market ticker/);
    expect(marketStatus(true)).toBe("live");
    expect(marketStatus(false)).toBe("paused");
    expect(tenorFromWeekly(true)).toBe("weekly");
    expect(tenorFromWeekly(false)).toBe("daily");
  });

  it("registers a handler for every frozen Clearinghouse event", () => {
    const source = readFileSync(new URL("./clearinghouse.ts", import.meta.url), "utf8");
    const events = clearinghouseAbi.filter((item) => item.type === "event").map((item) => item.name);
    const frozenEvents = [
      "MarketRegistered", "MarketConfigSet", "MintPausedSet", "SeriesCreated", "TransferSingle",
      "TransferBatch", "Minted", "Closed", "MintFeesAccrued", "SeriesSettled", "Redeemed", "Deposited", "Withdrawn",
      "OperatorSet", "PayoutPrefsSet", "ThirdPartyRedeemSet", "ApprovalForAll", "CreatePausedSet",
      "FeeRecipientSet", "PayoutAdapterSet", "FeesSwept", "URI",
    ];
    expect(events).toEqual(expect.arrayContaining(frozenEvents));
    for (const name of frozenEvents) {
      expect(source, `missing ${name}`).toContain(`ponder.on("Clearinghouse:${name}"`);
    }
  });
});
