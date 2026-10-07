'use server';

import { revalidatePath } from 'next/cache';
import { markAllNotificationsRead, markNotificationRead } from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Account actions, available to every signed-in person.
 *
 * Deliberately not scoped to an organisation: a resident has no membership, and
 * their profile and inbox are theirs regardless. RLS keys on auth.uid().
 */
export async function saveProfileAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    const fullName = String(formData.get('fullName') ?? '').trim();
    const phone = String(formData.get('phone') ?? '').trim();
    if (!fullName) throw new Error('Enter your name.');

    // The email is the sign-in identity and is deliberately NOT editable here:
    // changing it would change who the account is, which needs verification of
    // the new address rather than a text field.
    await tx`
      update user_profiles
         set full_name = ${fullName}, phone = ${phone || null}, updated_at = now()
       where auth_user_id = ${viewer.authUserId}::uuid
    `;
    return { fullName };
  });
  if (result.ok) revalidatePath('/account');
  return result;
}

export async function markNoticeReadAction(_previous: unknown, formData: FormData) {
  const id = String(formData.get('notificationId'));
  const result = await command(({ tx, viewer }) =>
    markNotificationRead(tx, viewer.authUserId, id).then(() => ({ id })),
  );
  if (result.ok) revalidatePath('/account/notifications');
  return result;
}

export async function markAllReadAction(_previous: unknown) {
  const result = await command(async ({ tx, viewer }) => ({
    marked: await markAllNotificationsRead(tx, viewer.authUserId),
  }));
  if (result.ok) revalidatePath('/account/notifications');
  return result;
}
