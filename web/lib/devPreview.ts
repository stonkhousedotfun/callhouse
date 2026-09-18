/** Inlined by Next at build time. The dev environment must never be indexed. */
export const DEV_PREVIEW = process.env.NEXT_PUBLIC_DEV_PREVIEW === "1";

/** Public buyer pages are indexable only in the non-preview v2 build. */
export const PUBLIC_V2_ROBOTS = {
  index: process.env.NEXT_PUBLIC_V2 === "1" && !DEV_PREVIEW,
  follow: !DEV_PREVIEW,
} as const;
