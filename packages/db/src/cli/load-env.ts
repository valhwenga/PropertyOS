/**
 * Loads the repository's .env.local for CLIs run on their own.
 *
 * `scripts/preview.sh` exports the connection details into the commands it
 * starts, so migrate and seed work inside it. Run by hand they did not: the
 * preview prints `pnpm db:mfa code <email>` as the way to get a fresh
 * second-factor code, and that command answered "DATABASE_URL is required"
 * — a config error dressed up as a missing argument.
 *
 * Anything already in the environment wins, so this cannot override a
 * deliberately set DATABASE_URL, and nothing is loaded in CI where no
 * .env.local exists.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadLocalEnv(): void {
  if (process.env.DATABASE_URL) return;
  // packages/db/src/cli -> repository root
  const envFile = fileURLToPath(new URL('../../../../.env.local', import.meta.url));
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch {
    // An unreadable or malformed file is not fatal: the caller still reports
    // the missing variable, which is the accurate complaint in that case.
  }
}
