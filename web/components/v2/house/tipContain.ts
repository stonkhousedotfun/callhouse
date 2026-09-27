// InfoTip anchors its bubble to the "?"; below lg this spans it across the page column so an open tip never widens the page.
export const TIP_CONTAIN = [
  "max-lg:[&_span:has(>[role=tooltip])]:static",
  "max-lg:[&_[role=tooltip]]:left-0",
  "max-lg:[&_[role=tooltip]]:right-0",
  "max-lg:[&_[role=tooltip]]:bottom-auto",
  "max-lg:[&_[role=tooltip]]:mt-7",
  "max-lg:[&_[role=tooltip]]:w-auto",
  "max-lg:[&_[role=tooltip]]:max-w-none",
  "max-lg:[&_[role=tooltip]]:translate-x-0",
].join(" ");
