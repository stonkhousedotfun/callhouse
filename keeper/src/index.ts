/**
 * Entry point of the keeper image (`node dist/index.js`): the v1 keeper, or a v2 mode.
 *
 *   V2_MODE unset or blank   → main-v1.ts, byte for byte the keeper this file used to be.
 *   V2_MODE=cranker|pricing|mm|pricer → v2/index.ts (anything else set there is refused, exit 1).
 *
 * WHY THE IMPORTS ARE DYNAMIC. ES module imports are evaluated before a line of this file runs, and
 * the v1 graph validates its environment the moment config.ts is evaluated: a v2 process has no
 * VAULT/FACTORY or KEEPER_PK and would exit 1 with v1's message before the switch could look at
 * V2_MODE. So neither graph is imported until the switch has chosen. mode.ts has no imports.
 *
 * DOTENV FIRST. V2_MODE may live in KEEPER_ENV_FILE (or ./.env) like every other key, so the file is
 * loaded here with the exact call config.ts makes. dotenv never overwrites a key that is already
 * set, so config.ts's own call on the v1 path then changes nothing: the environment v1 sees is the
 * one it always saw.
 */
import { config as loadDotenv } from 'dotenv';
import { requestedV2Mode } from './v2/mode.js';

loadDotenv({ path: process.env.KEEPER_ENV_FILE, quiet: true });

if (requestedV2Mode(process.env) === undefined) {
  await import('./main-v1.js');
} else {
  const { main } = await import('./v2/index.js');
  await main();
}
