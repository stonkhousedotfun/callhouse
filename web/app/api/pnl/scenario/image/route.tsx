import { parseScenario, renderScenarioImage } from "@/components/v2/PnlImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The explorer's share card (design §2.8). Only HTTP handlers and segment config may be exported from a
 * route file, so the query parsing lives next to the renderer in PnlImage.tsx. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shape = url.searchParams.get("format") === "square" ? "square" : "wide";
  return renderScenarioImage(parseScenario(url.searchParams), shape);
}
