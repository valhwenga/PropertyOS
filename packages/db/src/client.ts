import postgres from 'postgres';
import { appDatabaseUrl, privilegedDatabaseUrl } from './env';

export type Sql = postgres.Sql<Record<string, unknown>>;

let appClient: Sql | undefined;
let privilegedClient: Sql | undefined;
let isolationVerified = false;

/**
 * Connection options.
 *
 * Note on money: postgres.js returns `bigint` (OID 20) columns as STRINGS by
 * default and we deliberately do not override that. Every monetary value
 * therefore arrives as an exact decimal string and is converted to `BigInt` in
 * the domain layer. A 64-bit cent amount must never pass through a JS `number`.
 * `tests/db/bigint-fidelity.test.ts` pins this behaviour so a future postgres.js
 * upgrade cannot silently start coercing amounts to floats.
 */
const baseOptions: postgres.Options<Record<string, never>> = {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
};

/**
 * Settings for a connection that goes through a transaction-mode pooler.
 *
 * Managed Postgres in front of a serverless runtime means pgbouncer in
 * transaction mode (Supabase's port 6543, Neon's pooled host, RDS Proxy). Two
 * things are different there and both fail in ways that are hard to read:
 *
 *  * **Prepared statements do not survive.** The pooler hands each transaction
 *    whichever backend is free, so a statement prepared on one connection is
 *    unknown on the next: "prepared statement s1 already exists", intermittently
 *    and under load only. postgres.js names its statements by default, so this
 *    turns that off.
 *  * **The pool is the pooler's, not ours.** Ten idle connections per instance,
 *    times however many instances the platform decided to run, exhausts the
 *    pooler's own limit — and the symptom is a request that hangs rather than
 *    an error that names the cause.
 *
 * Detected from the URL rather than configured, because the host and port are
 * what actually decide it; `DATABASE_POOL_MODE` overrides either way for a
 * setup the heuristic does not recognise.
 */
export function usesTransactionPooler(url: string): boolean {
  const declared = process.env.DATABASE_POOL_MODE;
  if (declared === 'transaction') return true;
  if (declared === 'session') return false;
  return /[?&]pgbouncer=true/.test(url) || /:6543\//.test(url) || /-pooler\./.test(url);
}

function optionsFor(url: string, max: number): postgres.Options<Record<string, never>> {
  if (!usesTransactionPooler(url)) return { ...baseOptions, max };
  return { ...baseOptions, max: Math.min(max, 3), prepare: false };
}

/** The RLS-enforced connection. Every request-scoped query uses this. */
export function sql(): Sql {
  if (!appClient) {
    const url = appDatabaseUrl();
    appClient = postgres(url, optionsFor(url, 10)) as Sql;
  }
  return appClient;
}

/**
 * The privileged connection. Migrations and the worker's job-claiming loop only.
 *
 * Deliberately NOT exported from the package index: a module that wants this has
 * to reach for it by name, which makes an accidental bypass of tenant isolation
 * visible in review.
 */
export function privilegedSql(): Sql {
  if (!privilegedClient) {
    const url = privilegedDatabaseUrl();
    privilegedClient = postgres(url, optionsFor(url, 4)) as Sql;
  }
  return privilegedClient;
}

export async function closeConnections(): Promise<void> {
  await Promise.all([appClient?.end({ timeout: 5 }), privilegedClient?.end({ timeout: 5 })]);
  appClient = undefined;
  privilegedClient = undefined;
  isolationVerified = false;
}

/**
 * Fail-closed startup check.
 *
 * Verifies that the application connection cannot bypass Row Level Security.
 * A superuser or a role carrying BYPASSRLS would make every policy in the schema
 * decorative, so we refuse to serve traffic in that configuration rather than
 * discovering it during an incident.
 */
export async function assertApplicationRoleIsIsolated(): Promise<void> {
  if (isolationVerified) return;
  const client = sql();
  const [row] = await client<{ usename: string; superuser: boolean; bypassrls: boolean }[]>`
    select r.rolname       as usename,
           r.rolsuper      as superuser,
           r.rolbypassrls  as bypassrls
    from pg_roles r
    where r.rolname = current_user
  `;
  if (!row) {
    throw new Error('Could not resolve the current database role.');
  }
  if (row.superuser || row.bypassrls) {
    throw new Error(
      `APP_DATABASE_URL connects as "${row.usename}", which ` +
        `${row.superuser ? 'is a superuser' : 'carries BYPASSRLS'}. ` +
        `Row Level Security would not be enforced. Point APP_DATABASE_URL at a ` +
        `login role that is a member of propertyos_app and holds neither attribute.`,
    );
  }
  isolationVerified = true;
}
