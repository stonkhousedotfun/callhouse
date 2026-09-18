import { describe, expect, it } from "vitest";

import { V2ConfirmedStepError, V2ReceiptUnknownError } from "@/lib/v2/txStatus";
import { submittedReceiptStatus, unknownReceiptToast, v2ReceiptNotice } from "./TxToast";

const hash = `0x${"2".repeat(64)}` as const;

describe("v2 receipt status notice", () => {
  it("labels a submitted transaction as unknown and retains its explorer hash", () => {
    const error = new Error("The buyback completed", {
      cause: new V2ReceiptUnknownError(hash, "close", new Error("RPC timeout")),
    });
    const notice = v2ReceiptNotice(error);
    expect(notice).toMatchObject({ tone: "unknown", hash });
    expect(notice?.title).toContain("status unknown");
    expect(notice?.body).toContain("Check the explorer link");
    expect(notice?.body).not.toMatch(/stopped|failed|try again/i);
  });

  it("leaves a known failure to the normal error notice", () => {
    expect(v2ReceiptNotice(new Error("The transaction reverted on chain."))).toBeNull();
  });

  it("surfaces confirmed buyback without claiming an uncertain close failed", () => {
    const unknownClose = new V2ReceiptUnknownError(hash, "close", new Error("RPC timeout"));
    const wrapped = new V2ConfirmedStepError("The buyback completed, but close did not.",
      "The buyback confirmed.", unknownClose);
    const notice = v2ReceiptNotice(wrapped);
    expect(notice).toMatchObject({ tone: "unknown", hash });
    expect(notice?.body).toMatch(/^The buyback confirmed\. A wallet transaction was submitted/);
    expect(notice?.body).not.toMatch(/close did not|close failed|long units remain/i);
  });

  it("surfaces confirmed sale or cancellation before an uncertain follow-up", () => {
    const unknownPlace = new V2ReceiptUnknownError(hash, "place", new Error("RPC timeout"));
    const sale = new V2ConfirmedStepError("The remaining ask was not listed.",
      "The immediate sale confirmed.", unknownPlace);
    expect(v2ReceiptNotice(sale)?.body).toMatch(/^The immediate sale confirmed\./);
    const cancel = new V2ConfirmedStepError("Review Portfolio before retrying.",
      "The old order was cancelled.", unknownPlace);
    expect(v2ReceiptNotice(cancel)?.body).toMatch(/^The old order was cancelled\./);
  });

  it("keeps an unavailable receipt distinct from a reverted legacy transaction", async () => {
    const unavailable = async () => { throw new Error("RPC timeout"); };
    expect(await submittedReceiptStatus(hash, unavailable)).toBe("unknown");
    expect(await submittedReceiptStatus(hash, async () => ({ status: "reverted" }))).toBe("reverted");
    expect(await submittedReceiptStatus(hash, async () => ({ status: "success" }))).toBe("success");
    expect(unknownReceiptToast(hash)).toMatchObject({ tone: "unknown", hash,
      title: "Transaction submitted; status unknown" });
  });
});
