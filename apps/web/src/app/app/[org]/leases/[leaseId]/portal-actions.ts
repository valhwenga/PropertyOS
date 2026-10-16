'use server';

import { revalidatePath } from 'next/cache';
import { issueInvitation, revokePortalAccess } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Resident portal access.
 *
 * `issueInvitation` and `revokePortalAccess` have existed since §8 with no
 * screen: an operator could not invite a resident to the portal at all.
 *
 * Nothing here sends an email, and nothing claims to. The link is returned
 * once and handed to the operator to pass on — an "invitation sent" over an
 * adapter with no provider configured is a lie the resident discovers by never
 * receiving it.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function issuePortalInvitationAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const leaseId = str(formData, 'leaseId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const issued = await issueInvitation(tx, context.organisationId, viewer.authUserId, {
      leaseId,
      residentId: str(formData, 'residentId'),
      email: str(formData, 'email'),
      // The name the operator saw on the review row, sent back so the domain
      // can refuse if the form was for a different resident than the one the
      // request carries. Linking an address to the wrong resident is a
      // security incident, not a typo.
      confirmedRecipient: str(formData, 'confirmedRecipient'),
    });
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      email: str(formData, 'email').trim().toLowerCase(),
      residentName: str(formData, 'confirmedRecipient'),
    };
  });

  // Deliberately does NOT revalidate the lease page.
  //
  // The token exists in readable form exactly once, in this result. Marking
  // the page stale re-renders the panel, which now sees an invitation on the
  // record and swaps the form for the revoke branch — destroying the card with
  // the link on it before the operator has read it. The list being a reload
  // behind is a cost worth paying for the one thing they came here to collect.
  return result;
}

export async function revokePortalAccessAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const leaseId = str(formData, 'leaseId');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await revokePortalAccess(tx, context.organisationId, viewer.authUserId, {
      portalLinkId: str(formData, 'portalLinkId'),
      reason: str(formData, 'reason'),
    });
    return { revoked: true };
  });

  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}
