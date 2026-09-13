/**
 * Build config for the marketing site. Two lines here exist only because of how this package
 * is shipped — Railway builds the Dockerfile with the REPO ROOT as the build context, and runs
 * the produced container itself.
 *
 * `output: 'standalone'` makes Next emit .next/standalone: the server plus only the node_modules
 * it actually traced. That is what the container runs. Without it the image has to carry the
 * whole pnpm store to start.
 *
 * `outputFileTracingRoot` must be the repo root, not this package. pnpm installs dependencies as
 * symlinks into ../node_modules/.pnpm, so the real files sit OUTSIDE site/. Next's default
 * tracing root is the package directory, which silently drops everything behind those symlinks
 * and produces a standalone bundle that only fails at runtime, on Railway, with a missing module.
 * Node 22 gives us import.meta.dirname, so no fileURLToPath dance.
 *
 * Deliberately absent: any webpack() block (Next 16 builds with Turbopack, and a `webpack` key
 * with no matching `turbopack` key is a hard build error), any redirects or rewrites to the dapp
 * (every CTA here is an absolute external link to app.callhouse.xyz — see lib/site.ts), and any
 * image loader config, because this site ships no remote images.
 */
import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  reactStrictMode: true,
  turbopack: {},
};

export default nextConfig;
