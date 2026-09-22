import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(import.meta.dirname, "../app");
const README = resolve(import.meta.dirname, "../README.md");
const V2_TABLE_HEADER = "| V2 route | Purpose |";

// The table deliberately uses one wildcard for the isolated v1 run-off subtree.
// `/legacy/*` represents both `/legacy` itself and every page below `/legacy/`.
const TABLE_ROUTE_EXPANSIONS = {
  "/legacy/*": (route: string) => route === "/legacy" || route.startsWith("/legacy/"),
} as const;

// A page may be omitted only by naming its route and a durable reason here. An empty object means
// every page.tsx route must be represented by the V2 table or one of its declared expansions.
const EXCLUDED_PAGE_ROUTES: Readonly<Record<string, string>> = {};

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(entryPath);
    return entry.isFile() && entry.name === "page.tsx" ? [entryPath] : [];
  });
}

function routePattern(file: string): string {
  const pagePath = relative(APP_ROOT, file)
    .replaceAll("\\", "/")
    .replace(/(^|\/)page\.tsx$/, "");
  // App Router `[name]` segments are documented as `<name>`; literal segments stay unchanged.
  const segments = pagePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const dynamic = segment.match(/^\[([^\]]+)\]$/);
      return dynamic ? `<${dynamic[1]}>` : segment;
    });
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function documentedRoutes(readme: string): string[] {
  const lines = readme.split("\n");
  const header = lines.findIndex((line) => line.trim() === V2_TABLE_HEADER);
  if (header === -1) {
    throw new Error(`README is missing the exact V2 route table header: ${V2_TABLE_HEADER}`);
  }

  const rows = lines.slice(header + 2);
  const routes: string[] = [];
  for (const line of rows) {
    if (!line.trim().startsWith("|")) break;
    const routeCell = line.slice(1).split("|", 1)[0];
    const route = routeCell.match(/`([^`]+)`/)?.[1];
    if (!route) throw new Error(`V2 route table row has no route pattern: ${line}`);
    routes.push(route);
  }
  return routes;
}

describe("web README route table", () => {
  it("matches every App Router page in both directions", () => {
    const pages = new Set(pageFiles(APP_ROOT).map(routePattern));
    const table = documentedRoutes(readFileSync(README, "utf8"));
    const excluded = new Set(Object.keys(EXCLUDED_PAGE_ROUTES));

    const unknownExclusions = [...excluded].filter((route) => !pages.has(route));
    expect(
      unknownExclusions,
      `EXCLUDED_PAGE_ROUTES names routes with no page.tsx: ${unknownExclusions.join(", ")}`,
    ).toEqual([]);

    const representedPages = new Set<string>();
    const tableRowsWithoutPages: string[] = [];
    for (const tableRoute of table) {
      const expansion = TABLE_ROUTE_EXPANSIONS[tableRoute as keyof typeof TABLE_ROUTE_EXPANSIONS];
      const matches = expansion
        ? [...pages].filter(expansion)
        : pages.has(tableRoute)
          ? [tableRoute]
          : [];
      if (matches.length === 0) tableRowsWithoutPages.push(tableRoute);
      matches.forEach((route) => representedPages.add(route));
    }

    const pagesWithoutTableRows = [...pages]
      .filter((route) => !representedPages.has(route) && !excluded.has(route))
      .sort();

    expect(
      pagesWithoutTableRows,
      `page.tsx routes missing from the README V2 table: ${pagesWithoutTableRows.join(", ")}`,
    ).toEqual([]);
    expect(
      tableRowsWithoutPages.sort(),
      `README V2 table rows with no page.tsx: ${tableRowsWithoutPages.sort().join(", ")}`,
    ).toEqual([]);
  });
});
