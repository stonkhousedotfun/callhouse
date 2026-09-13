/**
 * Flat config. Next 16 removed `next lint`, and ESLint 9 no longer reads `.eslintrc.json`, so
 * the scaffold's legacy config is gone and this file replaces it. `eslint-config-next` 16 ships
 * flat configs on its subpath exports.
 */
import coreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...(Array.isArray(coreWebVitals) ? coreWebVitals : [coreWebVitals]),
];

export default config;
