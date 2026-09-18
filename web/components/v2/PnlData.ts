import { cache } from "react";
import { v2Api } from "@/lib/v2/api";
import type { PnlResponse } from "@/lib/v2/api-types";

export const validPnlId = (id: string) => /^[A-Za-z0-9-]{1,180}$/.test(id);

/** API failures and unknown IDs share a clear fallback on public pages and image routes. */
export const loadPnl = cache(async (id: string): Promise<PnlResponse | null> => {
  if (!validPnlId(id)) return null;
  try { return await v2Api.getPnl(id); } catch { return null; }
});
