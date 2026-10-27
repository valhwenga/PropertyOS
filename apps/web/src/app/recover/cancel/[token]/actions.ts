'use server';

import { privilegedSql } from '@propertyos/db/client';
import { cancelRecoveryWithToken, DomainError } from '@propertyos/domain';
import { log } from '@/lib/logger';

/**
 * The account holder stopping a recovery they did not ask for.
 *
 * This is the whole of the protection behind Spike's waiting period, so it is
 * deliberately the easiest thing on the page: one button, no sign-in, no
 * second factor — somebody who has lost both of those is exactly who needs it.
 *
 * A POST rather than a link that acts when it is opened: mail clients and link
 * scanners fetch URLs, and a recovery that a scanner can cancel is one the
 * account holder cannot rely on either way.
 */
export async function cancelRecoveryAction(_previous: unknown, formData: FormData) {
  const cancelToken = String(formData.get('cancelToken') ?? '');
  try {
    const sql = privilegedSql();
    await sql.begin(async (tx) =>
      cancelRecoveryWithToken(tx as never, { cancelToken }));
    return { ok: true as const };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false as const, message: error.message };
    log('error', 'recovery cancellation failed', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    return { ok: false as const, message: 'That could not be cancelled. Ring Spike support.' };
  }
}
