/**
 * Creates a disposable test database, applies every migration from empty, and
 * provisions the restricted application login role.
 *
 * Migrations are applied from scratch on every run, which is itself part of the
 * definition of done: "migrations are reproducible from an empty database".
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres';
const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'propertyos_test';
const APP_ROLE = 'propertyos_app_login';
const APP_PASSWORD = 'test-only-password';

function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    if (password) url.password = password;
  }
  return url.toString();
}

export async function setup(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
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
