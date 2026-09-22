import path from "node:path";

/**
 * Browser response policy, shipped report-only until launch verification exercises every route.
 *
 * The network origin classes are deliberately documented here beside `connect-src`:
 * - Wallet providers come from the MetaMask SDK fallback or injected extensions
 *   (`web/lib/wagmi.ts:11-18,21-39`); the SDK may negotiate over HTTPS/WSS.
 * - Chain reads use the two build-time RPC origins (`web/lib/chain.ts:19-20,31-52`). They are
 *   HTTP transports at this base; local rehearsals may use loopback HTTP.
 * - The browser indexer client reads NEXT_PUBLIC_API_URL (`web/lib/v2/api.ts:66,129-154`).
 * - The optional alert client reads NEXT_PUBLIC_NOTIFIER_URL (`web/lib/v2/notifier.ts:61-80`).
 *
 * Keep this as Content-Security-Policy-Report-Only until launch verification loads the app with
 * browser devtools open and accounts for every violation. Enforcing an unobserved policy risks
 * disabling wallet or read traffic. `unsafe-inline` reflects Next's current bootstrap/style
 * output; moving to nonces requires separately scoped request middleware.
 *
 * HSTS intentionally omits `preload`. Preloading is an owner decision and a one-way door whose
 * removal takes months; a parent-domain `includeSubDomains` commitment also binds `app.` and
 * `dev.`. The reversible response header ships now, without enrolling the domain in preload.
 */
const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*",
      "font-src 'self' data: https:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'self' https:",
      "img-src 'self' data: blob: https:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

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
 * The two keys below exist for the Docker image (web/Dockerfile → Railway → app.stonkhouse.fun).
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
  poweredByHeader: false,
  turbopack: {},
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  async headers() {
    const headers = [...SECURITY_HEADERS];
    if (process.env.NEXT_PUBLIC_DEV_PREVIEW === "1") {
      headers.push({ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" });
    }
    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
