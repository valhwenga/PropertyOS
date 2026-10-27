'use server';

import { headers } from 'next/headers';
import { withAnonymous } from '@propertyos/db';
import { DomainError, requestAccountRecovery } from '@propertyos/domain';
import { clientAddressHash } from '@/lib/rate-limit';
import { log } from '@/lib/logger';

/**
 * Asking for a way back in.
 *
 * Public, so it cannot go through `command`, which requires the session this
 * person has just lost. It follows the application form's shape: no actor, the
 * address hash passed to the database rather than counted here, and the same
 * answer every time.
 *
 * It returns success for an address with no account, for an address that
 * already has a request open, and for a real one. A form that says "no account
 * with that address" is a way to find out who has an account, and this one is
 * reachable by anybody.
 */
export async function requestRecoveryAction(_previous: unknown, formData: FormData) {
  const text = (key: string) => String(formData.get(key) ?? '').trim();
  const lost = text('lost');

  try {
    const header = await headers();
    const origin = header.get('origin');
    const host = header.get('host');
    if (origin && host && ![`https://${host}`, `http://${host}`].includes(origin)) {
      return { ok: false as const, message: 'This request did not originate from PropertyOS.' };
    }

    const ipHash = await clientAddressHash();
    await withAnonymous((tx) => requestAccountRecovery(tx, {
      email: text('email'),
      lost: lost === 'password' || lost === 'second_factor' || lost === 'both'
        ? lost
        : 'both',
      ...(text('note') ? { note: text('note') } : {}),
      ipHash,
    }));
    return { ok: true as const };
  } catch (error) {
    // The rate limit is raised deliberately and is written to be read; the
    // text of anything else can carry schema, so it is logged instead.
    if (error instanceof DomainError) {
      return { ok: false as const, message: error.message };
    }
    const message = error instanceof Error ? error.message : 'unknown';
    if (/too many recovery requests/i.test(message)) {
      return {
        ok: false as const,
        message: 'Too many recovery requests from this network today. Try again tomorrow, '
          + 'or ring whoever administers your account.',
      };
    }
    log('error', 'recovery request failed', { message });
    return {
      ok: false as const,
      message: 'That could not be submitted. Try again, or ring whoever administers your account.',
    };
  }
}
