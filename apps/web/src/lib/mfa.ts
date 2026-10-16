import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Sql } from '@propertyos/db';
import { enrolmentUri, generateSecret, verifyCode } from '@propertyos/integrations';

/**
 * Enrolling a second factor, and recovering from a lost one.
 *
 * The assurance machinery has existed since 0015: a role can require a second
 * factor, a session carries its level, and an elevated permission is withheld
 * from a single-factor session. There was no way for a person to enrol one —
 * the only path was `pnpm db:mfa enrol`, run against the database. So a
 * colleague invited as a finance approver could sign in, correctly see almost
 * nothing, and have no way out of that state.
 *
 * This lives beside the sign-in code rather than in the domain package for the
 * same reason sign-in does: `auth_mfa_factors` holds TOTP secrets and its
 * privileges are revoked from the application role. Every function here takes
 * the connection explicitly, so the one that can reach those tables is passed
 * in by the caller rather than reached for.
 *
 * What none of this does is let one person touch another's factor. There is no
 * administrator reset, and Spike has no path either: an administrator who
 * could clear a colleague's second factor could take over their account, which
 * is precisely what the factor is for. Recovery codes are the answer to a lost
 * phone, which is why they are generated at enrolment rather than offered
 * afterwards.
 */

/** Ten is enough to survive a lost phone and few enough to print on a card. */
const RECOVERY_CODE_COUNT = 10;

export interface MfaStatus {
  /** A verified factor the person is actually signing in with. */
  enrolled: boolean;
  /** Started but never confirmed with a code. It grants nothing. */
  pending: boolean;
  unusedRecoveryCodes: number;
  enrolledAt: string | null;
}

export async function mfaStatus(sql: Sql, authUserId: string): Promise<MfaStatus> {
  const [factor] = await sql<{ verified_at: string | null }[]>`
    select verified_at::text from auth_mfa_factors
     where auth_user_id = ${authUserId} and factor_type = 'totp'
  `;
  const [codes] = await sql<{ total: string }[]>`
    select count(*)::text as total from auth_mfa_recovery_codes
     where auth_user_id = ${authUserId} and used_at is null
  `;
  return {
    enrolled: Boolean(factor?.verified_at),
    pending: Boolean(factor) && !factor?.verified_at,
    unusedRecoveryCodes: Number(codes?.total ?? '0'),
    enrolledAt: factor?.verified_at ?? null,
  };
}

export type EnrolmentStart =
  | { ok: true; secret: string; uri: string }
  | { ok: false; reason: 'already_enrolled' };

/**
 * Starts enrolment.
 *
 * The secret is returned because it has to be: a TOTP secret is shared with
 * the authenticator app by showing it. It is stored UNVERIFIED, so an
 * abandoned enrolment grants nothing and changes nothing — the session's
 * assurance level is unaffected until a code proves the app actually has it.
 *
 * Starting again replaces an unverified secret rather than adding a second.
 * Somebody who lost their place half-way through should not end up with two
 * entries in their app and no way to tell which one the server kept.
 */
export async function beginEnrolment(
  sql: Sql, authUserId: string, email: string,
): Promise<EnrolmentStart> {
  const status = await mfaStatus(sql, authUserId);
  if (status.enrolled) return { ok: false, reason: 'already_enrolled' };

  const secret = generateSecret();
  await sql`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret)
    values (${authUserId}, 'totp', ${secret})
    on conflict (auth_user_id, factor_type) do update
      set secret = excluded.secret, verified_at = null, created_at = now()
  `;

  return {
    ok: true,
    secret,
    uri: enrolmentUri({ secret, account: email, issuer: 'Spike PropertyOS' }),
  };
}

/** A recovery code: short enough to read aloud, long enough not to be guessed. */
function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[randomInt(alphabet.length)]!;
  const group = () => Array.from({ length: 5 }, pick).join('');
  return `${group()}-${group()}`;
}

const hashCode = (code: string) =>
  createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest();

async function issueRecoveryCodes(sql: Sql, authUserId: string): Promise<string[]> {
  // Any code generated before now stops working. Re-issuing because you fear
  // the old list leaked has to actually retire the old list.
  await sql`delete from auth_mfa_recovery_codes where auth_user_id = ${authUserId}`;

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  for (const code of codes) {
    await sql`
      insert into auth_mfa_recovery_codes (auth_user_id, code_hash)
      values (${authUserId}, ${hashCode(code)})
    `;
  }
  return codes;
}

export type EnrolmentConfirmation =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'nothing_pending' | 'bad_code' | 'replayed' };

/**
 * Confirms enrolment with a code from the app.
 *
 * The code proves the app really holds the secret — without this step somebody
 * could enrol a secret they mistyped and discover it at the moment they next
 * needed to sign in.
 *
 * Recovery codes are generated here, at the one moment the person is looking
 * at the screen and knows what they are for. Offering them later, as a
 * separate thing to go and do, means they are never there when the phone is
 * lost.
 */
export async function confirmEnrolment(
  sql: Sql, authUserId: string, code: string,
): Promise<EnrolmentConfirmation> {
  const [factor] = await sql<{ secret: string; verified_at: string | null }[]>`
    select secret, verified_at::text from auth_mfa_factors
     where auth_user_id = ${authUserId} and factor_type = 'totp'
     for update
  `;
  if (!factor || factor.verified_at) return { ok: false, reason: 'nothing_pending' };

  const verification = verifyCode(factor.secret, code);
  if (!verification.valid || verification.step === undefined) {
    return { ok: false, reason: 'bad_code' };
  }

  // The same replay protection sign-in uses. A code spent on enrolment is not
  // then available to sign in with.
  const claimed = await sql`
    insert into auth_mfa_used_codes (auth_user_id, time_step)
    values (${authUserId}, ${verification.step})
    on conflict do nothing
    returning time_step
  `;
  if (claimed.length === 0) return { ok: false, reason: 'replayed' };

  await sql`
    update auth_mfa_factors set verified_at = now()
     where auth_user_id = ${authUserId} and factor_type = 'totp'
  `;

  return { ok: true, recoveryCodes: await issueRecoveryCodes(sql, authUserId) };
}

/**
 * Issues a fresh set of recovery codes, retiring the old ones.
 *
 * Only for somebody who already has a verified factor: codes without a factor
 * would be a password-only way past a second factor that does not exist yet.
 */
export async function regenerateRecoveryCodes(
  sql: Sql, authUserId: string,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: 'not_enrolled' }> {
  const status = await mfaStatus(sql, authUserId);
  if (!status.enrolled) return { ok: false, reason: 'not_enrolled' };
  return { ok: true, recoveryCodes: await issueRecoveryCodes(sql, authUserId) };
}

/**
 * Removes the factor, and every recovery code with it.
 *
 * Leaving the codes behind would be the worst of both worlds: a set of
 * single-use passwords for an account with no second factor on it.
 */
export async function removeFactor(sql: Sql, authUserId: string): Promise<void> {
  await sql`delete from auth_mfa_recovery_codes where auth_user_id = ${authUserId}`;
  await sql`
    delete from auth_mfa_factors
     where auth_user_id = ${authUserId} and factor_type = 'totp'
  `;
}

/**
 * Spends a recovery code in place of an authenticator code.
 *
 * Single use, and the attempt is recorded against the code so the person can
 * be told how many are left — and so a code being spent is visible rather than
 * silent.
 */
export async function consumeRecoveryCode(
  sql: Sql, authUserId: string, code: string, ipHash: string | null,
): Promise<{ ok: boolean; remaining: number }> {
  const trimmed = code.trim();
  if (trimmed.length < 8) {
    const [left] = await sql<{ total: string }[]>`
      select count(*)::text as total from auth_mfa_recovery_codes
       where auth_user_id = ${authUserId} and used_at is null
    `;
    return { ok: false, remaining: Number(left?.total ?? '0') };
  }

  const spent = await sql<{ id: string }[]>`
    update auth_mfa_recovery_codes
       set used_at = now(), used_ip_hash = ${ipHash}
     where auth_user_id = ${authUserId}
       and code_hash = ${hashCode(trimmed)}
       and used_at is null
    returning id
  `;

  const [left] = await sql<{ total: string }[]>`
    select count(*)::text as total from auth_mfa_recovery_codes
     where auth_user_id = ${authUserId} and used_at is null
  `;
  return { ok: spent.length > 0, remaining: Number(left?.total ?? '0') };
}

/**
 * The secret, grouped for someone typing it in by hand.
 *
 * There is no QR code here. Rendering one would mean either a dependency or a
 * few hundred lines of error-correction arithmetic, and every authenticator
 * app accepts a typed secret — so the honest version is the one that works
 * today rather than a promise of a picture.
 */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Used only to keep a timing difference from revealing whether an account exists. */
export function decoySecret(): string {
  return randomBytes(20).toString('base64url');
}
