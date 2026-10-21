'use server';

import { revalidatePath } from 'next/cache';
import {
  approveSupportSession, closeSupportSession, grantSupportAccess, revokeSupportAccessGrant,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * The customer deciding about Spike's access to their own records.
 *
 * None of these is privileged. The permission `support.access.manage` — held by
 * an organisation administrator, and described in the schema as "authorise and
 * revoke Spike support sessions" — is the authorisation, enforced by the
 * row-level policies these updates run against. Each domain function reads the
 * `returning` of its own update and refuses loudly when the policy declined,
 * because a decision about who may read your records must never be reported as
 * taken when it was not.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');
const path = (org: string) => `/app/${org}/settings/support-access`;

export async function approveSupportSessionAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(({ tx, viewer }) =>
    approveSupportSession(tx, viewer.authUserId, {
      supportSessionId: str(formData, 'supportSessionId'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath(path(org));
  return result;
}

/** Declining and ending are the same act on the same record: it is revoked. */
export async function endSupportSessionAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(({ tx, viewer }) =>
    closeSupportSession(tx, viewer.authUserId, {
      supportSessionId: str(formData, 'supportSessionId'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath(path(org));
  return result;
}

export async function openSupportWindowAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  // The organisation is resolved from the viewer's own memberships rather than
  // trusted from the form, because this one writes a row keyed on it.
  const context = await requireOperator(org);
  const result = await command(async ({ tx, viewer }) => {
    const grant = await grantSupportAccess(tx, context.organisationId, viewer.authUserId, {
      hours: str(formData, 'hours'),
      reason: str(formData, 'reason'),
    });
    return { expiresAt: grant.expiresAt.toISOString() };
  });
  if (result.ok) revalidatePath(path(org));
  return result;
}

export async function closeSupportWindowAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const { sessionsStillLive } = await revokeSupportAccessGrant(tx, viewer.authUserId, {
      grantId: str(formData, 'grantId'),
    });
    return { sessionsStillLive };
  });
  if (result.ok) revalidatePath(path(org));
  return result;
}
