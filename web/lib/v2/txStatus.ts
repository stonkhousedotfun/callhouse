import type { Hex, PublicClient, TransactionReceipt } from "viem";

/** A wallet returned a hash, but the RPC could not establish the transaction outcome. */
export class V2ReceiptUnknownError extends Error {
  constructor(readonly hash: Hex, readonly operation: string, cause: unknown) {
    super("A transaction was submitted, but its confirmation could not be checked.", { cause });
    this.name = "V2ReceiptUnknownError";
  }
}

/** Context from a completed earlier transaction in a multi-step action. */
export class V2ConfirmedStepError extends Error {
  constructor(message: string, readonly confirmedSummary: string, cause: unknown) {
    super(message, { cause });
    this.name = "V2ConfirmedStepError";
  }
}

/** Preserve the hash across the contextual errors raised by multi-step UI flows. */
export function findV2ReceiptUnknown(error: unknown): V2ReceiptUnknownError | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    if (current instanceof V2ReceiptUnknownError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

export function findV2ConfirmedStep(error: unknown): V2ConfirmedStepError | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    if (current instanceof V2ConfirmedStepError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

/** A rejected receipt read means unknown status; a reverted receipt is a known failure. */
export async function waitForV2Receipt(client: PublicClient, hash: Hex, operation: string): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try { receipt = await client.waitForTransactionReceipt({ hash }); }
  catch (cause) { throw new V2ReceiptUnknownError(hash, operation, cause); }
  if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
  return receipt;
}
