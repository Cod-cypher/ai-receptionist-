/**
 * Loads the repository-root `.env` for standalone scripts (migrate, seed, the
 * call simulator).
 *
 * The Nest app finds it through ConfigModule, but these scripts run with npm's
 * working directory set to `apps/api`, where a bare `dotenv/config` looks for a
 * `.env` that does not exist. Without this, `npm run migrate` only worked with a
 * `VAR=value npm run migrate` prefix — bash syntax that fails in PowerShell.
 *
 * Variables already set in the environment win, so CI and containers can still
 * inject their own values.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

const candidates = [
  resolve(process.cwd(), '.env'),
  // src/database -> repository root
  resolve(__dirname, '../../../../.env'),
];

for (const path of candidates) {
  if (existsSync(path)) {
    config({ path, quiet: true });
    break;
  }
}
