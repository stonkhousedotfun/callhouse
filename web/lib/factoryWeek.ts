/**
 * Factory `week()` is five named outputs. viem may hand them back as a named object, an
 * array, or both. Account and Book both need the same parse; a missed `id` looks like
 * "week closed" for one render and hides the offer form.
 */
export type FactoryWeek = {
  id: number;
  strikeUsdg: bigint;
  exerciseTs: number;
  baseExpiryTs: number;
  askUsdg: bigint;
};

function pick(data: object, name: string, index: number): unknown {
  const rec = data as Record<string, unknown>;
  return rec[name] ?? rec[index];
}

function asBig(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && value !== "") {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function parseFactoryWeek(data: unknown): FactoryWeek | undefined {
  if (data === null || data === undefined || typeof data !== "object") return undefined;
  const id = asNum(pick(data, "id", 0));
  const strikeUsdg = asBig(pick(data, "strikeUsdg", 1));
  const exerciseTs = asNum(pick(data, "exerciseTs", 2));
  const baseExpiryTs = asNum(pick(data, "baseExpiryTs", 3));
  const askUsdg = asBig(pick(data, "askUsdg", 4));
  if (
    id === undefined ||
    strikeUsdg === undefined ||
    exerciseTs === undefined ||
    baseExpiryTs === undefined ||
    askUsdg === undefined
  ) {
    return undefined;
  }
  return { id, strikeUsdg, exerciseTs, baseExpiryTs, askUsdg };
}
