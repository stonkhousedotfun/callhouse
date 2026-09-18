import { loadPnl } from "@/components/v2/PnlData";
import { renderPnlImage } from "@/components/v2/PnlImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const shape = new URL(request.url).searchParams.get("format") === "square" ? "square" : "wide";
  const pnl = await loadPnl((await params).id);
  return renderPnlImage(pnl, shape);
}
