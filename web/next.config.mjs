import path from "node:path";

/**
 * Next 16 builds with Turbopack by default.
 *
 * The scaffold carried a `webpack()` block that marked `pino-pretty`, `lokijs` and
 * `encoding` as externals — those are WalletConnect's optional transitive deps. This app
 * uses no WalletConnect connector (connectkit / @walletconnect are deliberately NOT
 * installed), so nothing pulls them in and the externals list has no job. Keeping a
 * `webpack` key with no matching `turbopack` key is a hard build error on Next 16, so the
 * block is gone and an empty `turbopack` config states the intent explicitly.
 *
 * ---------------------------------------------------------------------------------------
 * The two keys below exist for the Docker image (web/Dockerfile → Railway → app.callhouse.finance).
 *
 * `output: 'standalone'` makes `next build` emit a self-contained server plus the subset of
 * node_modules it actually traced. The runner stage ships that and nothing else: no pnpm, no
 * source tree, no dev dependencies. Without it the image would have to carry the whole
 * workspace install to run `next start`, and this app is not statically exportable anyway —
 * app/api/keeper/orders is `force-dynamic` and runs on the server per request.
 *
 * `outputFileTracingRoot` is the one that surprises people. This is a pnpm workspace, so the
 * real dependency tree lives at the REPO ROOT (../node_modules/.pnpm), not in web/node_modules,
 * which is a farm of symlinks into it. Left to guess, Next picks a tracing root by walking up
 * for a lockfile and warns about it; pinning it makes the output deterministic. The consequence
 * to remember is that the standalone tree MIRRORS this root — the server entry point is
 * `.next/standalone/web/server.js`, not `.next/standalone/server.js`, and `.next/static` has to
 * be copied alongside it at `web/.next/static`. web/Dockerfile's runner stage depends on exactly
 * that layout and asserts it at build time.
 * ---------------------------------------------------------------------------------------
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
};

export default nextConfig;
