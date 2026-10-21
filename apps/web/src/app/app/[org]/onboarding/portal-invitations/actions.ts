'use server';

import { revalidatePath } from 'next/cache';
import { invalid, issuePortalInvitations } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Inviting a list of residents to the portal in one go.
 *
 * The rows come back from the form carrying the name the operator READ beside
 * each checkbox, and the domain compares that with the resident on the lease
 * now. That is not ceremony: sending one resident's statements and balances to
 * another is the incident §8 of the blueprint names, and the single-invitation
 * screen has always made an operator confirm the recipient for exactly that
 * reason. Doing fifty at once must not be the way around it.
 */
export async function issueBulkInvitationsAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);

    // One checkbox per candidate, value "<leaseId>:<residentId>", with the
    // name and address the operator saw carried alongside it.
    const chosen = formData.getAll('invite').map(String);
    if (chosen.length === 0) throw invalid('Choose at least one resident to invite.');

    const rows = chosen.map((key) => {
      const [leaseId = '', residentId = ''] = key.split(':');
      return {
        leaseId,
        residentId,
        email: String(formData.get(`email:${key}`) ?? ''),
        confirmedRecipient: String(formData.get(`name:${key}`) ?? ''),
      };
    });

    const outcome = await issuePortalInvitations(
      tx, context.organisationId, viewer.authUserId, rows,
    );
    return outcome;
  });

  if (result.ok) revalidatePath(`/app/${org}/onboarding/portal-invitations`);
  return result;
}
