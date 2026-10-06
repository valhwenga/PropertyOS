/**
 * Creates a disposable test database, applies every migration from empty, and
 * provisions the restricted application login role.
 *
 * Migrations are applied from scratch on every run, which is itself part of the
 * definition of done: "migrations are reproducible from an empty database".
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Picks up the connection details `scripts/preview.sh` already worked out.
 *
 * Without this, running the suite on a cluster whose superuser has a password —
 * every Debian and Ubuntu install — needed TEST_ADMIN_DATABASE_URL exported by
 * hand, and the failure was an opaque "password authentication failed" from
 * deep inside the driver. Anything already in the environment wins, so CI and
 * one-off overrides are unaffected.
 */
const ENV_FILE = fileURLToPath(new URL('../../.env.local', import.meta.url));
if (existsSync(ENV_FILE) && !process.env.TEST_ADMIN_DATABASE_URL) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // An unreadable or malformed .env.local is not fatal: the defaults below
    // still apply, and a connection failure reports itself clearly.
  }
}

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres';
const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'propertyos_test';
/**
 * The harness has its OWN login role, deliberately not the one the application
 * and `scripts/preview.sh` use.
 *
 * It used to reuse `propertyos_app_login` and reset its password on every run.
 * Roles are cluster-wide, not per-database, so running `pnpm test` while the
 * preview was up silently revoked the preview's own credential: the app started
 * answering 503 from /healthz, with nothing in the test output to suggest the
 * tests had caused it.
 *
 * Both roles are members of `propertyos_app` and both are stripped of SUPERUSER
 * and BYPASSRLS, so the isolation tests still exercise exactly the privilege
 * level a real web request has.
 */
const APP_ROLE = 'propertyos_test_app_login';
const APP_PASSWORD = 'test-only-password';

/** Keeps a password out of an error message that may be pasted into an issue. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    if (password) url.password = password;
  }
  return url.toString();
}

/**
 * Refuses to drop anything that is not obviously a throwaway test database.
 *
 * This harness DROPS the database it is pointed at. Running it against a
 * development, staging or production database destroys it, and the only thing
 * standing between those outcomes is an environment variable. The guard is here
 * because I made exactly that mistake: pointing TEST_DATABASE_NAME at the
 * development database wiped its seed data.
 *
 * Opt out deliberately with ALLOW_DESTRUCTIVE_TEST_DB=true if a differently
 * named database really is disposable.
 */
function assertDisposable(name: string): void {
  if (process.env.ALLOW_DESTRUCTIVE_TEST_DB === 'true') return;
  if (/^(propertyos_)?test(_|$)|_test$|^propertyos_test$/.test(name)) return;
  throw new Error(
    `Refusing to drop database "${name}": its name does not identify it as a test database. ` +
      'The test harness DROPS the database it is given. Name it like "propertyos_test", ' +
      'or set ALLOW_DESTRUCTIVE_TEST_DB=true if you are certain it is disposable.',
  );
}

export async function setup(): Promise<void> {
  assertDisposable(TEST_DB);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the destructive test harness with NODE_ENV=production.');
  }

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    try {
      await admin.unsafe('select 1');
    } catch (error) {
      // The driver's own message names neither the host it tried nor the fix,
      // so a first run against a fresh cluster reads as a mystery.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot reach PostgreSQL as a superuser at ${redact(ADMIN_URL)}: ${detail}\n` +
          'The test harness creates and drops its own database, so it needs a superuser ' +
          'connection. Run ./scripts/preview.sh once — it provisions the cluster and ' +
          'records the connection in .env.local — or set TEST_ADMIN_DATABASE_URL yourself.',
      );
    }
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        else
          alter role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
        -- Explicitly stripped so the isolation self-check has something real to
        -- verify: this role must never be able to bypass Row Level Security.
        alter role ${APP_ROLE} nosuperuser nobypassrls nocreatedb nocreaterole;
      end $$;
    `);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const dbUrl = urlFor(TEST_DB);
  execFileSync('pnpm', ['--filter', '@propertyos/db', 'migrate'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  });

  const owner = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    await owner.unsafe(`grant propertyos_app to ${APP_ROLE}`);
    await owner.unsafe(`grant connect on database ${TEST_DB} to ${APP_ROLE}`);
  } finally {
    await owner.end({ timeout: 5 });
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.APP_DATABASE_URL = urlFor(TEST_DB, APP_ROLE, APP_PASSWORD);
}

export async function teardown(): Promise<void> {
  // The database is intentionally left in place for post-run inspection; the
  // next run drops and recreates it.
}
