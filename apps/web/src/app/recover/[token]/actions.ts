'use server';

import { privilegedSql } from '@propertyos/db/client';
import { completeRecovery, DomainError } from '@propertyos/domain';
import { hashPassword } from '@/lib/session';
import { log } from '@/lib/logger';

/**
 * Spending a recovery link.
 *
 * Runs on a privileged connection for the same reason `/join/[token]` does:
 * the person has no session, and the token is the only credential there is.
 * Every check that matters is in `completeRecovery` — the link must be
 * approved, in date, past its waiting period, and unspent.
 *
 * The provider guard is not a formality. This writes `auth.users.password_hash`
 * and deletes rows from `auth_mfa_factors`, which is where the LOCAL auth
 * provider keeps credentials. With `AUTH_PROVIDER=supabase`, Supabase owns
 * them and this would change nothing while telling somebody their password had
 * been reset — a silent failure in the one flow where silence is unacceptable.
 */
export async function completeRecoveryAction(_previous: unknown, formData: FormData) {
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const needsPassword = String(formData.get('needsPassword') ?? '') === 'yes';

  if (process.env.AUTH_PROVIDER === 'supabase') {
    return {
      ok: false as const,
      message: 'Recovery cannot be completed in this deployment: credentials are held by '
        + 'Supabase Auth and this link does not reach them. Ask Spike support.',
    };
  }

  if (needsPassword) {
    if (password.length < 12) {
      return { ok: false as const, message: 'Choose a password of at least 12 characters.' };
    }
    if (password !== confirm) {
      return { ok: false as const, message: 'Those two passwords do not match.' };
    }
  }

  try {
    const sql = privilegedSql();
    const outcome = await sql.begin(async (tx) => completeRecovery(tx as never, {
      token,
      ...(needsPassword ? { newPasswordHash: await hashPassword(password) } : {}),
    }));
    return { ok: true as const, lost: outcome.lost };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false as const, message: error.message };
    log('error', 'recovery completion failed', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    return { ok: false as const, message: 'That did not go through. Ask for a new link.' };
  }
}
