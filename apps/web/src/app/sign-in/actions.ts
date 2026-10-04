'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { privilegedSql } from '@propertyos/db/client';
import {
  resolveAuthProviderName, supabaseAuthConfig, supabaseSignIn, verifyCode,
} from '@propertyos/integrations';
import { createSession, verifyPassword } from '@/lib/session';
import {
  checkSignInRate, clearFailures, clientAddressHash, recordAttempt,
} from '@/lib/rate-limit';

export interface SignInState {
  error: string | null;
  correlationId?: string;
  /** Set when credentials were accepted but a second factor is still needed. */
  mfaRequired?: boolean;
  pendingEmail?: string;
}

/**
 * The response for a wrong email, a wrong password and an unknown account is
 * deliberately identical, so the form cannot be used to enumerate accounts.
 */
const GENERIC = 'Those details do not match an account.';

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const correlationId = randomUUID();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '').trim();

  if (!email || !password) {
    return { error: 'Enter your email address and password.', correlationId };
  }

  const ipHash = await clientAddressHash();
  const rate = await checkSignInRate(email, ipHash);
  if (!rate.allowed) {
    await recordAttempt(email, ipHash, 'rate_limited');
    return {
      error:
        'Too many failed attempts. Please wait about 15 minutes before trying again, ' +
        'or reset your password.',
      correlationId,
    };
  }

  const provider = resolveAuthProviderName();

  /* ------------------------------------------------------------- Supabase */
  if (provider === 'supabase') {
    const config = supabaseAuthConfig();
    if (!config) {
      return {
        error:
          'This deployment is configured for Supabase Auth but NEXT_PUBLIC_SUPABASE_URL ' +
          'and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Sign-in is unavailable.',
        correlationId,
      };
    }
    const result = await supabaseSignIn(config, { email, password });

    if (result.status === 'rejected') {
      await recordAttempt(email, ipHash, result.reason === 'rate_limited' ? 'rate_limited' : 'bad_credentials');
      if (result.reason === 'unavailable') {
        return {
          error: 'The authentication service could not be reached. Please try again shortly.',
          correlationId,
        };
      }
      return { error: GENERIC, correlationId };
    }
    if (result.status === 'mfa_required') {
      await recordAttempt(email, ipHash, 'mfa_required');
      return {
        error: null,
        mfaRequired: true,
        pendingEmail: email,
        correlationId,
      };
    }

    await ensureProfile(result.authUserId, email);
    await recordAttempt(email, ipHash, 'success');
    await clearFailures(email);
    // The assurance level is whatever SUPABASE confirmed, never an assumption.
    await createSession(result.authUserId, result.assuranceLevel);
    redirect('/');
  }

  /* ---------------------------------------------------------------- Local */
  const sql = privilegedSql();
  const [user] = await sql<{ id: string; password_hash: string | null }[]>`
    select id, password_hash from auth.users where email = ${email}
  `;
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    await recordAttempt(email, ipHash, 'bad_credentials');
    return { error: GENERIC, correlationId };
  }

  const [factor] = await sql<{ id: string; secret: string; verified_at: string | null }[]>`
    select id, secret, verified_at from auth_mfa_factors
    where auth_user_id = ${user.id} and factor_type = 'totp'
  `;
  const mfaEnrolled = Boolean(factor?.verified_at);

  if (mfaEnrolled && !code) {
    await recordAttempt(email, ipHash, 'mfa_required');
    return { error: null, mfaRequired: true, pendingEmail: email, correlationId };
  }

  let assurance: 'aal1' | 'aal2' = 'aal1';
  if (mfaEnrolled) {
    const verification = verifyCode(factor!.secret, code);
    if (!verification.valid || verification.step === undefined) {
      await recordAttempt(email, ipHash, 'mfa_failed');
      return {
        error: 'That code is not valid. Check your authenticator app and try again.',
        mfaRequired: true,
        pendingEmail: email,
        correlationId,
      };
    }
    // Replay protection: a code is good for exactly one sign-in.
    const replayed = await sql`
      insert into auth_mfa_used_codes (auth_user_id, time_step)
      values (${user.id}, ${verification.step})
      on conflict do nothing
      returning time_step
    `;
    if (replayed.length === 0) {
      await recordAttempt(email, ipHash, 'mfa_failed');
      return {
        error: 'That code has already been used. Wait for your app to show a new one.',
        mfaRequired: true,
        pendingEmail: email,
        correlationId,
      };
    }
    assurance = 'aal2';
  }

  await recordAttempt(email, ipHash, 'success');
  await clearFailures(email);
  await createSession(user.id, assurance);
  redirect('/');
}

/**
 * Supabase owns the auth user; PropertyOS owns the profile. A first sign-in
 * creates the profile row so memberships can be attached to it.
 */
async function ensureProfile(authUserId: string, email: string): Promise<void> {
  const sql = privilegedSql();
  await sql`
    insert into auth.users (id, email) values (${authUserId}, ${email})
    on conflict (id) do nothing
  `;
  await sql`
    insert into user_profiles (auth_user_id, full_name, email)
    values (${authUserId}, ${email}, ${email})
    on conflict (auth_user_id) do nothing
  `;
}
