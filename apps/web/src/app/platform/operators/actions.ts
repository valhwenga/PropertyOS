'use server';

import { revalidatePath } from 'next/cache';
import {
  inviteOperator, revokeOperator, setOperatorRoles, withdrawOperatorInvitation,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Administering Spike's own staff.
 *
 * Privileged for the reason every platform command is: an operator is
 * deliberately a member of no organisation, so membership-keyed filtering
 * would otherwise stand in the way. The authorisation is unaffected — each of
 * these resolves `platform.operators.manage` in SQL, through the same function
 * the policies on these tables use.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');
const roles = (f: FormData) => f.getAll('roles').map((r) => String(r));

export async function inviteOperatorAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    const invited = await inviteOperator(tx, viewer.authUserId, {
      email: str(formData, 'email'),
      fullName: str(formData, 'fullName'),
      roles: roles(formData),
    });
    return {
      // Shown once. Only a hash is stored, so nobody can recover it after.
      token: invited.token,
      email: str(formData, 'email').trim().toLowerCase(),
      expiresAt: invited.expiresAt.toISOString(),
    };
  }, { privileged: true });

  // Not this page: re-rendering it would throw away the one copy of the link.
  if (result.ok) revalidatePath('/platform');
  return result;
}

export async function setOperatorRolesAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    setOperatorRoles(tx, viewer.authUserId, {
      operatorUserId: str(formData, 'operatorUserId'),
      roles: roles(formData),
    }).then(() => ({})),
  { privileged: true });
  if (result.ok) revalidatePath('/platform/operators');
  return result;
}

export async function revokeOperatorAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    revokeOperator(tx, viewer.authUserId, str(formData, 'operatorUserId')).then(() => ({})),
  { privileged: true });
  if (result.ok) revalidatePath('/platform/operators');
  return result;
}

export async function withdrawOperatorInvitationAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    withdrawOperatorInvitation(tx, viewer.authUserId, str(formData, 'invitationId'))
      .then(() => ({})),
  { privileged: true });
  if (result.ok) revalidatePath('/platform/operators');
  return result;
}
