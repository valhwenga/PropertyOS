'use server';

import { revalidatePath } from 'next/cache';
import {
  approveRecoveryAsAdministrator, cancelRecovery,
  changeMemberRoles, inviteStaff, reinstateMember, revokeStaffInvitation,
  setMemberScope, suspendMember,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Colleagues.
 *
 * Nothing here sends an email. The invitation link is returned once and shown
 * to whoever issued it, and the screen says the link has to be passed on —
 * rather than displaying a reassuring "invitation sent" over an adapter that
 * delivered nothing.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

function scopeFrom(formData: FormData):
  { type: 'organisation' } | { type: 'property'; propertyId: string } {
  const propertyId = str(formData, 'propertyId');
  return propertyId ? { type: 'property', propertyId } : { type: 'organisation' };
}

export async function inviteStaffAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const { invitationId, token, expiresAt } = await inviteStaff(
      tx, context.organisationId, viewer.authUserId, {
        email: str(formData, 'email'),
        fullName: str(formData, 'fullName'),
        roles: formData.getAll('roles').map(String),
        scope: scopeFrom(formData),
      },
    );
    return {
      invitationId,
      // The one moment the token exists in readable form. It is stored only as
      // a hash, so this cannot be shown again and nobody can recover it later.
      token,
      expiresAt: expiresAt.toISOString(),
      email: str(formData, 'email').trim().toLowerCase(),
    };
  });

  if (result.ok) revalidatePath(`/app/${org}/settings/staff`);
  return result;
}

export async function revokeInvitationAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await revokeStaffInvitation(tx, context.organisationId, viewer.authUserId, {
      invitationId: str(formData, 'invitationId'),
      reason: str(formData, 'reason'),
    });
    return { revoked: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/staff`);
  return result;
}

export async function changeRolesAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await changeMemberRoles(tx, context.organisationId, viewer.authUserId, {
      membershipId: str(formData, 'membershipId'),
      roles: formData.getAll('roles').map(String),
      reason: str(formData, 'reason'),
    });
    return { saved: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/staff`);
  return result;
}

export async function changeScopeAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await setMemberScope(tx, context.organisationId, viewer.authUserId, {
      membershipId: str(formData, 'membershipId'),
      scope: scopeFrom(formData),
      reason: str(formData, 'reason'),
    });
    return { saved: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/staff`);
  return result;
}

export async function suspendMemberAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const reinstating = str(formData, 'intent') === 'reinstate';

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const input = {
      membershipId: str(formData, 'membershipId'),
      reason: str(formData, 'reason'),
    };
    if (reinstating) {
      await reinstateMember(tx, context.organisationId, viewer.authUserId, input);
    } else {
      await suspendMember(tx, context.organisationId, viewer.authUserId, input);
    }
    return { done: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/staff`);
  return result;
}

/**
 * Deciding whether a colleague gets back into their account.
 *
 * The same permission that invites and removes them, `membership.manage`,
 * because it is the same kind of act and the same person is the right judge of
 * it: the colleague who can tell whether this is really them.
 *
 * Approving does not let anybody in. It produces a link, returned here so the
 * screen can show it to whoever approved it — they hand it over the way they
 * already hand over a staff invitation, by whatever channel they trust.
 */
export async function approveRecoveryAction(_previous: unknown, formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const result = await command(async ({ tx, viewer }) => {
    const approval = await approveRecoveryAsAdministrator(tx, viewer.authUserId, {
      requestId: String(formData.get('requestId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    });
    return approval;
  });
  if (result.ok) revalidatePath(`/app/${slug}/settings/staff`);
  return result;
}

export async function declineRecoveryAction(_previous: unknown, formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const result = await command(({ tx, viewer }) =>
    cancelRecovery(tx, viewer.authUserId, {
      requestId: String(formData.get('requestId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})));
  if (result.ok) revalidatePath(`/app/${slug}/settings/staff`);
  return result;
}
