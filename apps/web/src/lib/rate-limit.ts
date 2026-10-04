import 'server-only';
import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { privilegedSql } from '@propertyos/db/client';

/**
 * Sign-in rate limiting.
 *
 * Counted per email AND per client address, because an attacker spraying one
 * password across many accounts is not caught by a per-account limit alone.
 *
 * Attempts are recorded on the privileged connection: the caller has no session
 * yet, so there is no RLS context to run under, and the table is unreadable by
 * the application roles.
 */

const EMAIL_LIMIT = 8;
const IP_LIMIT = 30;
const WINDOW_MINUTES = 15;

export async function clientAddressHash(): Promise<string> {
  const header = await headers();
  // Trusted only as a coarse grouping key for rate limiting. It is hashed so the
  // table never stores a raw address.
  const forwarded = header.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = forwarded || header.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(`propertyos:${address}`).digest('hex').slice(0, 32);
}

export type AttemptOutcome =
  | 'success' | 'bad_credentials' | 'mfa_required' | 'mfa_failed' | 'rate_limited';

export async function recordAttempt(
  email: string | null,
  ipHash: string,
  outcome: AttemptOutcome,
): Promise<void> {
  const sql = privilegedSql();
  await sql`
    insert into auth_attempts (email, ip_hash, outcome)
    values (${email}, ${ipHash}, ${outcome})
  `;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export async function checkSignInRate(email: string, ipHash: string): Promise<RateLimitVerdict> {
  const sql = privilegedSql();
  const [row] = await sql<{ email_failures: string; ip_failures: string }[]>`
    select
      (select count(*) from auth_attempts
        where email = ${email}
          and outcome in ('bad_credentials', 'mfa_failed')
          and attempted_at > now() - (${WINDOW_MINUTES} || ' minutes')::interval)::text as email_failures,
      (select count(*) from auth_attempts
        where ip_hash = ${ipHash}
          and outcome in ('bad_credentials', 'mfa_failed')
          and attempted_at > now() - (${WINDOW_MINUTES} || ' minutes')::interval)::text as ip_failures
  `;
  const emailFailures = Number(row?.email_failures ?? 0);
  const ipFailures = Number(row?.ip_failures ?? 0);

  if (emailFailures >= EMAIL_LIMIT || ipFailures >= IP_LIMIT) {
    return { allowed: false, retryAfterSeconds: WINDOW_MINUTES * 60 };
  }
  return { allowed: true };
}

/** Clears the counter after a genuine success, so one bad day is not a lockout. */
export async function clearFailures(email: string): Promise<void> {
  const sql = privilegedSql();
  await sql`
    delete from auth_attempts
    where email = ${email} and outcome in ('bad_credentials', 'mfa_failed')
  `;
}
