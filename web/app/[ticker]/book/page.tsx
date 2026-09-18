import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";

import LegacyPage, { generateMetadata as legacyMetadata, generateStaticParams } from "@/app/legacy/[ticker]/book/page";
import { legacyMarketPath } from "@/app/legacy/routes";

type Params = { ticker: string };
export const dynamicParams = false;
export { generateStaticParams };

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  return process.env.NEXT_PUBLIC_V2 === "1" ? { robots: { index: false } } : legacyMetadata(props);
}

export default async function BookPage(props: { params: Promise<Params> }) {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect(legacyMarketPath((await props.params).ticker, "book"));
  return <LegacyPage {...props} />;
}
