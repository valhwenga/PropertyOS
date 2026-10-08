'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { privilegedSql } from '@propertyos/db/client';
import { resolveAuthProviderName, verifyCode } from '@propertyos/integrations';
import { createSession, currentSession } from '@/lib/session';
import { checkSignInRate, clearFailures, clientAddressHash, recordAttempt } from '@/lib/rate-limit';
import { safeReturnTo } from './return-to';

export interface ReauthState {
  error: string | null;
  correlationId?: string;
}

/**
 * Proves the person at the keyboard is still the account holder.
 *
 * This does not sign anyone in and cannot be used to: the caller must already
 * hold a valid session, and the only thing a correct code changes is the
 * authentication instant on that same session. Getting it wrong leaves the
 * session exactly as it was — still signed in, still not fresh.
 */
export async function reauthenticate(
  _previous: ReauthState,
  formData: FormData,
): Promise<ReauthState> {
  const correlationId = randomUUID();
  const session = await currentSession();
  if (!session) redirect('/sign-in');

  const returnTo = safeReturnTo(String(formData.get('returnTo') ?? ''));
  const code = String(formData.get('code') ?? '').trim();
  if (!code) return { error: 'Enter the 6-digit code from your authenticator app.', correlationId };

  const sql = privilegedSql();
  const [user] = await sql<{ email: string }[]>`
    select email from auth.users where id = ${session.authUserId}
  `;
  if (!user) redirect('/sign-in');

  // Re-verification is a code-guessing surface like sign-in, so it is rate
  // limited on the same counters rather than offering an unlimited one.
  const ipHash = await clientAddressHash();
  const rate = await checkSignInRate(user.email, ipHash);
  if (!rate.allowed) {
    await recordAttempt(user.email, ipHash, 'rate_limited');
    return {
      error: 'Too many attempts. Please wait about 15 minutes before trying again.',
      correlationId,
    };
  }

  if (resolveAuthProviderName() === 'supabase') {
    // Honest refusal rather than a pretend success. Supabase owns the factor
    // challenge, and re-verifying against it is a separate piece of work that
    // has not been built or tested against the real service.
    return {
      error:
        'Re-verification is not available on this deployment yet. Sign out and sign in again '
        + 'to refresh your second factor.',
      correlationId,
    };
  }

  const [factor] = await sql<{ secret: string; verified_at: string | null }[]>`
    select secret, verified_at from auth_mfa_factors
    where auth_user_id = ${session.authUserId} and factor_type = 'totp'
  `;
  if (!factor?.verified_at) {
    return {
      error:
        'This action needs a second factor, and your account does not have one enrolled. '
        + 'Set up an authenticator app before making this change.',
      correlationId,
    };
  }

  const verification = verifyCode(factor.secret, code);
  if (!verification.valid || verification.step === undefined) {
    await recordAttempt(user.email, ipHash, 'mfa_failed');
    return { error: 'That code is not valid. Check your authenticator app and try again.', correlationId };
  }

  // The same replay protection sign-in uses: a code is good exactly once, so a
  // code shoulder-surfed moments ago cannot be used to re-verify.
  const replayed = await sql`
    insert into auth_mfa_used_codes (auth_user_id, time_step)
    values (${session.authUserId}, ${verification.step})
    on conflict do nothing
    returning time_step
  `;
  if (replayed.length === 0) {
    await recordAttempt(user.email, ipHash, 'mfa_failed');
    return {
      error: 'That code has already been used. Wait for your app to show a new one.',
      correlationId,
    };
  }

  await recordAttempt(user.email, ipHash, 'success');
  await clearFailures(user.email);
  // Re-issues the session at aal2 with a new authentication instant. This is
  // the only thing in the application that makes a session fresh.
  await createSession(session.authUserId, 'aal2');
  redirect(returnTo);
}
