import { getAddress, isAddress, type Address } from "viem";

export type RewardDistributor = {
  program: string;
  address: Address;
};

/**
 * Parse the multi-instance RewardsDistributor configuration.
 *
 * `V2_REWARDS_DISTRIBUTORS` is a JSON array so programs remain open strings and replacement
 * instances can stay listed beside the current one. The singular env var remains a maker-only
 * fallback for existing deployments; when both are present it must agree with one maker row.
 */
export function parseRewardDistributors(raw: string | undefined, legacy?: Address): RewardDistributor[] {
  if (raw === undefined || raw.trim() === "") {
    return legacy === undefined ? [] : [{ program: "maker", address: getAddress(legacy) }];
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("[callhouse/indexer] V2_REWARDS_DISTRIBUTORS must be valid JSON.");
  }
  if (!Array.isArray(value)) {
    throw new Error("[callhouse/indexer] V2_REWARDS_DISTRIBUTORS must be a JSON array.");
  }

  const seen = new Set<string>();
  const result = value.map((entry, index): RewardDistributor => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`[callhouse/indexer] V2_REWARDS_DISTRIBUTORS[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const program = typeof record.program === "string" ? record.program.trim() : "";
    const candidate = record.address;
    if (program === "") {
      throw new Error(`[callhouse/indexer] V2_REWARDS_DISTRIBUTORS[${index}].program must be a non-empty string.`);
    }
    if (typeof candidate !== "string" || !isAddress(candidate)) {
      throw new Error(`[callhouse/indexer] V2_REWARDS_DISTRIBUTORS[${index}].address is not a valid address.`);
    }
    const address = getAddress(candidate);
    const key = address.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`[callhouse/indexer] V2_REWARDS_DISTRIBUTORS repeats ${address}.`);
    }
    seen.add(key);
    return { program, address };
  });

  if (legacy !== undefined && !result.some((item) =>
    item.program === "maker" && item.address.toLowerCase() === legacy.toLowerCase())) {
    throw new Error(
      "[callhouse/indexer] V2_REWARDS_DISTRIBUTOR must match a maker entry in V2_REWARDS_DISTRIBUTORS.",
    );
  }
  return result;
}
