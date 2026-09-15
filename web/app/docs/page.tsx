import type { Metadata } from "next";
import Link from "next/link";

import { Button, ExternalLink, PageHead, Panel } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { FACTORY, MARKET } from "@/lib/contracts";
import { DOCS_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs — StonkHouse",
  description: "How StonkHouse works.",
};

export default function DocsPage() {
  return (
    <>
      <PageHead
        eyebrow="Docs"
        title="How this works"
        lede={`Put ${MARKET} in. Choose how much is for sale. If someone pays, you get USDG. If they don't, you keep the stock.`}
      />

      <Panel as="section" pad="lg" className="grid gap-4">
        <ol className="grid gap-3 text-[15.5px] text-ink-2">
          <li>
            <Link href="/account" className="link font-semibold">
              Account
            </Link>
            — deposit, set how much is for sale, list, settle, collect USDG.
          </li>
          <li>
            <Link href="/book" className="link font-semibold">
              Book
            </Link>
            — buy a call, or exercise one you already hold.
          </li>
        </ol>
        {FACTORY ? (
          <p className="text-[14px] text-ink-3">
            Factory{" "}
            <ExternalLink href={addressUrl(FACTORY)} className="link num">
              {FACTORY}
            </ExternalLink>
          </p>
        ) : null}
        <div>
          <Button href={DOCS_URL}>StonkHouse Docs</Button>
        </div>
      </Panel>
    </>
  );
}
