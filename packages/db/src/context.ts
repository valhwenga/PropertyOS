import type { Sql } from './client';
import { sql, privilegedSql, assertApplicationRoleIsIsolated } from './client';

/**
 * The verified identity of the caller.
 *
 * `authUserId` is taken from the server-verified session ONLY. There is no code
 * path that accepts it from a request body, header or URL.
 */
export interface RequestActor {
  authUserId: string;
  /**
   * Authenticator assurance level from the verified session. Row Level Security
   * and permission resolution read this, so an MFA-gated role grants nothing on
   * a single-factor session. Defaults to the WEAKER value when absent.
   */
  assuranceLevel?: 'aal1' | 'aal2';
  /**
   * When the second factor was last asserted, as epoch seconds.
   *
   * Assurance says a second factor was used at some point in this session;
   * freshness says it was used RECENTLY. Changing where money is paid should
   * need the latter, because an eight-hour session left open on an unattended
   * machine is still aal2. Absent means "not recently", never "just now".
   */
  authenticatedAt?: number;
  /**
   * The organisation the request is operating in. This is a *filter*, never a
   * grant: Row Level Security resolves what this user may actually see from
   * their membership rows, so supplying another organisation's id simply
   * returns nothing.
   */
  organisationId?: string;
  correlationId?: string;
}

export interface TxContext {
  tx: Sql;
  actor: RequestActor;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction whose Postgres session is bound to the caller.
 *
 * `request.jwt.claims` is what `auth.uid()` reads, which is in turn what every
 * RLS policy keys off. It is set with SET LOCAL so it dies with the transaction
 * and cannot leak into the next borrower of the pooled connection.
 */
export async function withActor<T>(
  actor: RequestActor,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<T> {
  if (!UUID.test(actor.authUserId)) {
    // Defensive: a malformed id must never be interpolated into a claims string.
    throw new Error('withActor requires a well-formed auth user id');
  }
  await assertApplicationRoleIsIsolated();
  const client = sql();
  return client.begin(async (tx) => {
    const claims = JSON.stringify({
      sub: actor.authUserId,
      role: 'authenticated',
      aal: actor.assuranceLevel === 'aal2' ? 'aal2' : 'aal1',
      // Supabase's claim name for the authentication instant. Omitted rather
      // than zeroed when unknown, so the SQL side reads it as absent and
      // treats the session as stale.
      ...(typeof actor.authenticatedAt === 'number' && Number.isFinite(actor.authenticatedAt)
        ? { auth_time: Math.floor(actor.authenticatedAt) }
        : {}),
    });
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return fn({ tx: tx as unknown as Sql, actor });
  }) as Promise<T>;
}

/**
 * An anonymous transaction: no `auth.uid()`, so every RLS policy evaluates to
 * false. Used for pre-authentication lookups that are explicitly public, and as
 * the default for anything that forgot to supply an actor.
 */
export async function withAnonymous<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  await assertApplicationRoleIsIsolated();
  const client = sql();
  return client.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', '', true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/**
 * A privileged transaction that still knows who the caller is.
 *
 * Some commands cannot run on the application role at all. Provisioning a
 * customer is the clearest case: every write policy in the schema is keyed on
 * membership, and a Spike operator is deliberately a member of nothing, so the
 * insert is refused — correctly. The operator is not acting *inside* a
 * customer organisation; they are bringing one into existence.
 *
 * So the role bypasses POLICIES, and the claims are set anyway. That second
 * part is the point. Without the claims, `auth.uid()` is null, so
 * `app.is_platform_operator()` reads false and a command's own authorisation
 * check cannot run — leaving a privileged connection whose only guard is that
 * the calling code remembered to check first. With them, the command verifies
 * the caller in SQL exactly as it would anywhere else, including the
 * second-factor requirement, and only the row-level filtering is lifted.
 *
 * Use it only where a policy keyed on membership is the thing in the way, and
 * only with an actor taken from a verified session. It is not a way round an
 * authorisation decision; it is a way to let one be made.
 */
export async function withPrivilegedActor<T>(
  actor: RequestActor,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<T> {
  if (!UUID.test(actor.authUserId)) {
    throw new Error('withPrivilegedActor requires a well-formed auth user id');
  }
  const client = privilegedSql();
  return client.begin(async (tx) => {
    const claims = JSON.stringify({
      sub: actor.authUserId,
      role: 'authenticated',
      aal: actor.assuranceLevel === 'aal2' ? 'aal2' : 'aal1',
      ...(typeof actor.authenticatedAt === 'number' && Number.isFinite(actor.authenticatedAt)
        ? { auth_time: Math.floor(actor.authenticatedAt) }
        : {}),
    });
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return fn({ tx: tx as unknown as Sql, actor });
  }) as Promise<T>;
}
