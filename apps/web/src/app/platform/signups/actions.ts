'use server';

import { revalidatePath } from 'next/cache';
import { approveSignupRequest, declineSignupRequest } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Deciding a request.
 *
 * Approving runs privileged for the same reason provisioning does: the
 * operator is deliberately a member of no organisation, so every
 * membership-keyed policy would otherwise stand in the way of creating one.
 * The operator's identity is still on the transaction and the platform-operator
 * check runs in SQL. Declining needs no such lift — the row is Spike's own.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function approveSignupRequestAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    const approved = await approveSignupRequest(tx, viewer.authUserId, {
      requestId: str(formData, 'requestId'),
      slug: str(formData, 'slug').trim().toLowerCase(),
      planKey: str(formData, 'planKey'),
      legalEntityName: str(formData, 'legalEntityName'),
      ...(str(formData, 'name').trim() ? { name: str(formData, 'name').trim() } : {}),
    });
    return {
      // Shown once and never recoverable, exactly as on the provisioning form.
      token: approved.token,
      slug: str(formData, 'slug').trim().toLowerCase(),
      expiresAt: approved.expiresAt.toISOString(),
    };
  }, { privileged: true });

  // The queue elsewhere is stale, but not this page: re-rendering it would
  // throw away the one copy of the link.
  if (result.ok) revalidatePath('/platform');
  return result;
}

export async function declineSignupRequestAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    declineSignupRequest(tx, viewer.authUserId, {
      requestId: str(formData, 'requestId'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/signups');
  return result;
}
