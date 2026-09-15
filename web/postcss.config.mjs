/**
 * PostCSS for the dapp (app.callhouse.finance): Tailwind CSS v4 and nothing else. Next picks this file up on its
 * own (Turbopack reads postcss.config.mjs), so no next.config.mjs change goes with it.
 *
 * Tailwind v4 needs no tailwind.config.*: the theme lives in app/globals.css (@theme inline over
 * the Daylight tokens) and source detection scans the repo, skipping .gitignore'd paths.
 * Autoprefixer is deliberately absent; @tailwindcss/postcss runs Lightning CSS, which already
 * handles vendor prefixes.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
