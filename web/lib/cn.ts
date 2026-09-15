/**
 * Join class names, dropping falsy entries: `cn("a", on && "b", undefined)` gives "a b".
 *
 * Deliberately not clsx + tailwind-merge. This does NOT resolve conflicts: `cn("px-4", "px-6")`
 * keeps both, and which one wins is decided by Tailwind's stylesheet order, not by argument
 * order. The ui/ primitives expose props for their variations for that reason; a `className`
 * passed to one should add layout (margins, grid placement, width), not restyle it. When an
 * override is truly needed, use Tailwind's important modifier (`px-6!`).
 */
export type ClassValue = string | false | null | undefined | 0;

export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
