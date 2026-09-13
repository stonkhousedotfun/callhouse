/**
 * Flat config, same shape as web/eslint.config.mjs. Next 16 removed `next lint` and ESLint 9 no
 * longer reads `.eslintrc.json`, so `pnpm lint` runs `eslint .` against this file.
 * `eslint-config-next` 16 ships flat configs on its subpath exports.
 */
import coreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...(Array.isArray(coreWebVitals) ? coreWebVitals : [coreWebVitals]),
];

export default config;
