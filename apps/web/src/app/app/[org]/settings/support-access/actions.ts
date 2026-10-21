'use server';

import { revalidatePath } from 'next/cache';
import { closeSupportSession } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * A customer revoking Spike's access to their own records.
 *
 * This screen has always told them they could: "You can revoke access at any
 * time." There was no button. The permission exists (`support.access.manage`,
 * held by an organisation administrator), the row-level policy that admits the
 * update exists, and the domain function exists — only the control was missing,
 * which made the one promise the support-session design rests on an untrue
 * sentence on a page.
 *
 * Not privileged, and it must not be: the policy keyed on
 * `support.access.manage` IS the authorisation here, and `closeSupportSession`
 * now fails loudly when that policy refuses rather than reporting a revoke that
 * did not happen. The slug is used only to mark the page stale.
 */
export async function revokeSupportSessionAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    closeSupportSession(tx, viewer.authUserId, {
      supportSessionId: String(formData.get('supportSessionId') ?? ''),
    }).then(() => ({})),
  );

  if (result.ok) {
    revalidatePath(`/app/${String(formData.get('org') ?? '')}/settings/support-access`);
  }
  return result;
}
