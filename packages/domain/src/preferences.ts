import type { Sql } from '@propertyos/db';
import { invalid } from './errors';

/**
 * A person's own settings.
 *
 * No permission check and no organisation: these belong to whoever is signed
 * in, operator and resident alike, and row level security on `user_profiles`
 * already keys on auth.uid(). Nothing here is audited either — what colour
 * somebody reads their screen in is not an event in the organisation's
 * history, and recording it would put a line in the audit trail every time a
 * tired person turned the lights down.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** What this person chose, or 'system' when they have not. */
export async function getThemeChoice(tx: Sql, authUserId: string): Promise<ThemeChoice> {
  const [row] = await tx<{ theme_choice: string }[]>`
    select theme_choice from user_profiles where auth_user_id = ${authUserId}::uuid
  `;
  return isThemeChoice(row?.theme_choice) ? row.theme_choice : 'system';
}

/** Records the choice against the account, so it follows the person. */
export async function setThemeChoice(
  tx: Sql, authUserId: string, choice: ThemeChoice,
): Promise<ThemeChoice> {
  if (!isThemeChoice(choice)) throw invalid('That is not a theme.');
  await tx`
    update user_profiles
       set theme_choice = ${choice}, updated_at = now()
     where auth_user_id = ${authUserId}::uuid
  `;
  return choice;
}
