import { loadPnl } from "@/components/v2/PnlData";
import { renderPnlImage } from "@/components/v2/PnlImage";

export const alt = "StonkHouse verified option outcome";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

export default async function OpengraphImage({ params }: { params: Promise<{ id: string }> }) {
  return renderPnlImage(await loadPnl((await params).id));
}
