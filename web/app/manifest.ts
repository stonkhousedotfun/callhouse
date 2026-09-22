import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Stonkhouse",
    short_name: "Stonkhouse",
    description: "Explore Stock Token options with a known maximum loss before you buy.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f8f6",
    theme_color: "#0a7f55",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
