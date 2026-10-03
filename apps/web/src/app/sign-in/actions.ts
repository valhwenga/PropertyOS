'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { withAnonymous } from '@propertyos/db';
import { createSession, verifyPassword } from '@/lib/session';

interface SignInState {
  error: string | null;
  correlationId?: string;
}

/**
 * Local development sign-in.
 *
 * Production uses Supabase Auth (AUTH_PROVIDER=supabase), which owns credential
 * storage, rate limiting and MFA. This path exists so the product is runnable
 * and testable without a Supabase project.
 *
 * The failure message is deliberately identical for an unknown email and a wrong
 * password, so the form cannot be used to enumerate accounts.
 */
export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const correlationId = randomUUID();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email address and password.', correlationId };
  }
  if (process.env.AUTH_PROVIDER === 'supabase') {
    return {
      error:
        'This deployment is configured for Supabase Auth, but the Supabase sign-in route is not ' +
        'enabled in this release. See docs/known-limitations.md.',
      correlationId,
    };
  }

  const generic = 'Those details do not match an account.';

  const authUserId = await withAnonymous(async (tx) => {
    // Read under the anonymous context: auth.users is not RLS-protected because
    // it is Supabase-owned, and only the id and hash are selected.
    const [user] = await tx<{ id: string; password_hash: string | null }[]>`
      select id, password_hash from auth.users where email = ${email}
    `;
    if (!user?.password_hash) return null;
    return (await verifyPassword(password, user.password_hash)) ? user.id : null;
  });

  if (!authUserId) return { error: generic, correlationId };

  await createSession(authUserId);
  redirect('/');
}
