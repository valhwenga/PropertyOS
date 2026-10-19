'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { isThemeChoice, markAllNotificationsRead, markNotificationRead, setThemeChoice } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { THEME_COOKIE } from '@/lib/theme';

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

/**
 * Saves the light/dark choice against the account.
 *
 * Two writes, deliberately: the row is the record, and the cookie is what the
 * root layout can read cheaply enough to render the right colour before the
 * first paint on a machine this person has never signed in on before.
 *
 * `system` clears the cookie rather than storing a third value, because the
 * server has no way of knowing what the device prefers — that question is
 * only answerable in the browser, and the inline script answers it there.
 */
export async function saveThemeAction(_previous: unknown, formData: FormData) {
  const choice = String(formData.get('theme') ?? '');
  const result = await command(async ({ tx, viewer }) => {
    if (!isThemeChoice(choice)) throw new Error('That is not a theme.');
    await setThemeChoice(tx, viewer.authUserId, choice);
    return { choice };
  });

  if (result.ok) {
    const jar = await cookies();
    if (choice === 'system') {
      jar.delete(THEME_COOKIE);
    } else {
      jar.set(THEME_COOKIE, choice, {
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
        sameSite: 'lax',
        // Readable by the no-flash script, which has to agree with it. It
        // carries a colour scheme; there is nothing here to protect.
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
      });
    }
    revalidatePath('/', 'layout');
  }
  return result;
}
