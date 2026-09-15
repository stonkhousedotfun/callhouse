/**
 * Inline icons. All draw in currentColor and are aria-hidden: they decorate text that already says
 * what they mean. Colour them with a text-* class on the icon or its parent. WarnIcon and
 * CheckCircleIcon are the mockup's two (copied from callhouse-site: components/ui/icons.tsx);
 * InfoIcon and StopIcon are the app's, drawn on the same 16-unit grid as WarnIcon.
 */
type IconProps = { size?: number; className?: string };

/** Warning triangle (.disclose, .note, the risks list). */
export function WarnIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      <path fill="currentColor" d="M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5.2v1.5h1.5v-1.5h-1.5Z" />
    </svg>
  );
}

/** Check in a circle (the benefits list). */
export function CheckCircleIcon({ size = 20, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" className={className}>
      <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M6 10.5l2.6 2.5L14 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "i" in a filled circle: a neutral fact the reader should know before acting. */
export function InfoIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm-.75 6v4.5h1.5V7h-1.5Zm0-2.75v1.5h1.5v-1.5h-1.5Z"
      />
    </svg>
  );
}

/** Octagon with a bar: something is refused or broken, not merely risky. */
export function StopIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Zm-.35 6.25v1.5h6.5v-1.5h-6.5Z"
      />
    </svg>
  );
}
