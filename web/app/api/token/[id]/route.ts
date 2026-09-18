import { APP_URL } from "@/lib/site";
import { v2Api } from "@/lib/v2/api";
import { tokenMetadataText } from "@/components/v2/PnlText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^(0|[1-9]\d*)$/.test(id)) return Response.json({ error: "Invalid token ID" }, { status: 400 });
  let tokenId: bigint;
  try { tokenId = BigInt(id); } catch { return Response.json({ error: "Invalid token ID" }, { status: 400 }); }
  if (tokenId === 0n || tokenId >= 2n ** 256n) return Response.json({ error: "Invalid token ID" }, { status: 400 });
  const isShort = (tokenId & 1n) === 1n;
  const longId = (tokenId & ~1n).toString();
  try {
    const { series } = await v2Api.getSeries(longId);
    const { title, description } = tokenMetadataText(series, isShort);
    const image = `${APP_URL}/${encodeURIComponent(series.ticker.toLowerCase())}/${longId}/opengraph-image`;
    return Response.json({ name: title, description, image, external_url: `${APP_URL}/${series.ticker.toLowerCase()}/${longId}`,
      attributes: [{ trait_type: "Side", value: isShort ? "Short" : "Long" },
        { trait_type: "Type", value: series.isPut ? "Put" : "Call" },
        { trait_type: "Ticker", value: series.ticker },
        { trait_type: "Strike", value: series.strike.formatted },
        { trait_type: "Expiry", value: series.expiry, display_type: "date" }] },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
  } catch {
    return Response.json({ error: "Series unavailable" }, { status: 404 });
  }
}
