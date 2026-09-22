import type { Address } from "viem";

import { V7_API_URL } from "./config";
import { v7PositionsResponseSchema, type V7PositionsResponse } from "./api-schema";

export class V7ApiUnavailable extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "V7ApiUnavailable";
  }
}

export class V7ApiClient {
  constructor(
    readonly baseUrl: string | null = V7_API_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getPositions(address: Address, signal?: AbortSignal): Promise<V7PositionsResponse> {
    if (!this.baseUrl) throw new V7ApiUnavailable("The v7 run-off indexer is not configured.");
    let response: Response;
    try {
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(
        `${this.baseUrl}/v2/accounts/${encodeURIComponent(address)}/positions`,
        { method: "GET", headers: { accept: "application/json" }, cache: "no-store", ...(signal ? { signal } : {}) },
      );
    } catch (cause) {
      throw new V7ApiUnavailable("The v7 run-off indexer is unavailable.", { cause });
    }
    if (!response.ok) throw new V7ApiUnavailable(`The v7 run-off indexer returned HTTP ${response.status}.`);
    let body: unknown;
    try { body = await response.json(); }
    catch (cause) { throw new V7ApiUnavailable("The v7 run-off indexer returned invalid JSON.", { cause }); }
    const parsed = v7PositionsResponseSchema.safeParse(body);
    if (!parsed.success) throw new V7ApiUnavailable("The v7 run-off indexer returned an unexpected response.");
    return parsed.data;
  }
}

export const v7Api = new V7ApiClient();
