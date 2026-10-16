/**
 * Enrolling a second factor, and recovering from a lost one.
 *
 * The assurance machinery has existed since 0015 — a role can require a second
 * factor, a session carries its level, and an elevated permission is withheld
 * from a single-factor session. There was no way for a person to enrol one.
 * The only path was `pnpm db:mfa enrol`, a developer command run against the
 * database, so a colleague invited as a finance approver could sign in,
 * correctly see almost nothing, and have no way out of that state.
 *
 * The rules under test: an unconfirmed enrolment grants nothing, a code proves
 * the app really has the secret, recovery codes are single-use and are issued
 * at enrolment rather than offered later, and nothing here lets one person
 * touch another's factor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateCode, timeStep } from '@propertyos/integrations';
import { hasPermission } from '@propertyos/domain';
import {
  beginEnrolment, confirmEnrolment, consumeRecoveryCode, groupSecret, mfaStatus,
  regenerateRecoveryCodes, removeFactor,
} from '../../apps/web/src/lib/mfa.js';
import {
  addMember, as, asSingleFactor, closeOwner, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

/**
 * A code from a window nothing has spent yet.
 *
 * A TOTP code is good for one use in one 30-second window, and this suite
 * spends several. Walking forward through windows is what the sign-in helper
 * does for the same reason.
 */
async function unusedCode(secret: string, authUserId: string): Promise<string> {
  const base = timeStep();
  for (let offset = 0; offset < 60; offset += 1) {
    const step = base + offset;
    const [used] = await ownerSql()<{ time_step: string }[]>`
      select time_step::text from auth_mfa_used_codes
       where auth_user_id = ${authUserId} and time_step = ${step}
    `;
    if (!used) return generateCode(secret, step);
  }
  throw new Error('no unused time step found');
}

describe('Second factor enrolment', () => {
  let org: OrganisationFixture;
  let approver: string;
  let other: string;

  beforeAll(async () => {
    org = await createOrganisation('Factor Co');
    approver = await addMember(org.organisationId, 'App Rover', ['finance_approver']);
    other = await addMember(org.organisationId, 'Some Body', ['finance_preparer']);
  });

  afterAll(async () => { await closeOwner(); });

  /* ---------------------------------------- the state enrolment exists to fix */

  it('withholds an elevated permission until a factor exists', async () => {
    // This is the state a newly invited approver lands in, and the reason
    // enrolment had to exist: the role is right, the permission is withheld.
    const allowed = await asSingleFactor(approver, (tx) =>
      hasPermission(tx, org.organisationId, 'deposit.refund.approve'),
    );
    expect(allowed).toBe(false);

    const status = await mfaStatus(ownerSql(), approver);
    expect(status.enrolled).toBe(false);
    expect(status.pending).toBe(false);
    expect(status.unusedRecoveryCodes).toBe(0);
  });

  /* ------------------------------------------------------------- enrolling */

  it('an unconfirmed enrolment grants nothing', async () => {
    const started = await beginEnrolment(ownerSql(), approver, 'approver@demo.invalid');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.uri).toContain('otpauth://totp/');
    expect(started.uri).toContain(started.secret);
    // Grouped for somebody typing it by hand, because there is no QR code and
    // pretending otherwise would be worse than saying so.
    expect(groupSecret(started.secret)).toMatch(/^(\w{4} )+\w{1,4}$/);

    const status = await mfaStatus(ownerSql(), approver);
    expect(status.pending).toBe(true);
    expect(status.enrolled).toBe(false);

    // The session's assurance is untouched: an abandoned enrolment changes
    // nothing at all.
    const allowed = await asSingleFactor(approver, (tx) =>
      hasPermission(tx, org.organisationId, 'deposit.refund.approve'),
    );
    expect(allowed).toBe(false);

    // And the profile flag still says what is true.
    const [profile] = await ownerSql()<{ mfa_enrolled: boolean }[]>`
      select mfa_enrolled from user_profiles where auth_user_id = ${approver}
    `;
    expect(profile!.mfa_enrolled).toBe(false);
  });

  it('starting again replaces the unverified secret rather than adding one', async () => {
    const first = await beginEnrolment(ownerSql(), approver, 'approver@demo.invalid');
    const second = await beginEnrolment(ownerSql(), approver, 'approver@demo.invalid');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.secret).not.toBe(first.secret);

    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from auth_mfa_factors
       where auth_user_id = ${approver}
    `;
    // One row. Two would leave two entries in their app and no way to tell
    // which the server kept.
    expect(total).toBe('1');

    // The abandoned secret stops working immediately.
    const stale = await confirmEnrolment(
      ownerSql(), approver, generateCode(first.secret, timeStep()),
    );
    expect(stale.ok).toBe(false);
  });

  it('refuses a code the app could not have produced', async () => {
    const result = await confirmEnrolment(ownerSql(), approver, '000000');
    expect(result).toMatchObject({ ok: false, reason: 'bad_code' });

    const status = await mfaStatus(ownerSql(), approver);
    expect(status.enrolled).toBe(false);
  });

  it('confirms with a real code, and hands over recovery codes there and then', async () => {
    const started = await beginEnrolment(ownerSql(), approver, 'approver@demo.invalid');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const confirmed = await confirmEnrolment(
      ownerSql(), approver, await unusedCode(started.secret, approver),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    // Issued at the one moment the person is looking at the screen and knows
    // what they are for. Offered later, they are never there when the phone
    // is lost.
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(new Set(confirmed.recoveryCodes).size).toBe(10);
    expect(confirmed.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const status = await mfaStatus(ownerSql(), approver);
    expect(status.enrolled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(10);

    // The profile flag is maintained by the factor table rather than by
    // whichever code path remembers to.
    const [profile] = await ownerSql()<{ mfa_enrolled: boolean }[]>`
      select mfa_enrolled from user_profiles where auth_user_id = ${approver}
    `;
    expect(profile!.mfa_enrolled).toBe(true);

    // Keep this for the recovery tests below.
    (globalThis as Record<string, unknown>).__codes = confirmed.recoveryCodes;
  });

  it('stores only hashes of the recovery codes', async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    const rows = await ownerSql()<{ code_hash: string }[]>`
      select encode(code_hash, 'hex') as code_hash from auth_mfa_recovery_codes
       where auth_user_id = ${approver}
    `;
    expect(rows).toHaveLength(10);
    const dump = JSON.stringify(rows);
    // A stolen database must not yield a way past somebody's second factor.
    for (const code of codes) {
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace('-', ''));
    }
  });

  it('will not start again once a factor is verified', async () => {
    const started = await beginEnrolment(ownerSql(), approver, 'approver@demo.invalid');
    // Otherwise a stolen session could silently swap the factor for one the
    // thief controls.
    expect(started).toMatchObject({ ok: false, reason: 'already_enrolled' });
  });

  /* -------------------------------------------------------------- recovery */

  it('spends a recovery code once and only once', async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    const code = codes[0]!;

    const first = await consumeRecoveryCode(ownerSql(), approver, code, 'test-ip');
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(9);

    const second = await consumeRecoveryCode(ownerSql(), approver, code, 'test-ip');
    expect(second.ok).toBe(false);
    expect(second.remaining).toBe(9);
  });

  it('accepts a code however the person types it', async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    // Lower case, no separator, stray spaces. Somebody reading a printed card
    // should not be defeated by punctuation.
    const typed = ` ${codes[1]!.replace('-', '').toLowerCase()} `;
    const result = await consumeRecoveryCode(ownerSql(), approver, typed, null);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(8);
  });

  it('refuses a code belonging to somebody else', async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    const result = await consumeRecoveryCode(ownerSql(), other, codes[2]!, null);
    expect(result.ok).toBe(false);

    // And it is still spendable by the person it belongs to.
    const owner = await consumeRecoveryCode(ownerSql(), approver, codes[2]!, null);
    expect(owner.ok).toBe(true);
  });

  it('records that a code was spent, and from where', async () => {
    const [row] = await ownerSql()<{ used_ip_hash: string | null; used_at: string | null }[]>`
      select used_ip_hash, used_at::text from auth_mfa_recovery_codes
       where auth_user_id = ${approver} and used_ip_hash is not null
       limit 1
    `;
    // A code being spent should be visible rather than silent: the person can
    // be asked "was that you".
    expect(row!.used_ip_hash).toBe('test-ip');
    expect(row!.used_at).toBeTruthy();
  });

  it('retires every old code when a new set is issued', async () => {
    const before = await mfaStatus(ownerSql(), approver);
    expect(before.unusedRecoveryCodes).toBe(7);

    const reissued = await regenerateRecoveryCodes(ownerSql(), approver);
    expect(reissued.ok).toBe(true);
    if (!reissued.ok) return;

    const after = await mfaStatus(ownerSql(), approver);
    expect(after.unusedRecoveryCodes).toBe(10);

    // Re-issuing because you fear the old list leaked has to actually retire
    // the old list.
    const old = (globalThis as Record<string, unknown>).__codes as string[];
    const stale = await consumeRecoveryCode(ownerSql(), approver, old[5]!, null);
    expect(stale.ok).toBe(false);

    (globalThis as Record<string, unknown>).__codes = reissued.recoveryCodes;
  });

  it('will not issue recovery codes to somebody with no factor', async () => {
    const result = await regenerateRecoveryCodes(ownerSql(), other);
    // Otherwise they would be a password-only way past a second factor that
    // does not exist.
    expect(result).toMatchObject({ ok: false, reason: 'not_enrolled' });
  });

  /* --------------------------------------------------------------- removal */

  it('takes the recovery codes with the factor when it is removed', async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    await removeFactor(ownerSql(), approver);

    const status = await mfaStatus(ownerSql(), approver);
    expect(status.enrolled).toBe(false);
    expect(status.pending).toBe(false);
    // Leaving them behind would be a set of single-use passwords for an
    // account with no second factor on it.
    expect(status.unusedRecoveryCodes).toBe(0);
    const orphaned = await consumeRecoveryCode(ownerSql(), approver, codes[0]!, null);
    expect(orphaned.ok).toBe(false);

    const [profile] = await ownerSql()<{ mfa_enrolled: boolean }[]>`
      select mfa_enrolled from user_profiles where auth_user_id = ${approver}
    `;
    expect(profile!.mfa_enrolled).toBe(false);

    // And the permission is withheld again, which is the whole point of the
    // level rather than of the role.
    const allowed = await asSingleFactor(approver, (tx) =>
      hasPermission(tx, org.organisationId, 'deposit.refund.approve'),
    );
    expect(allowed).toBe(false);
  });

  /* ------------------------------------------- nobody touches another's */

  it('keeps the factor tables unreachable by the application role', async () => {
    // 0015 revokes these outright, and the staff screen reads enrolment
    // through a function that returns only the fact. A reader who could reach
    // the table could read the secret.
    await expect(
      as(org.adminUserId, (tx) => tx`select secret from auth_mfa_factors limit 1`),
    ).rejects.toThrow(/permission denied/);

    await expect(
      as(org.adminUserId, (tx) => tx`select code_hash from auth_mfa_recovery_codes limit 1`),
    ).rejects.toThrow(/permission denied/);
  });

  it('tells a person only their own recovery count', async () => {
    await beginEnrolment(ownerSql(), other, 'other@demo.invalid');
    const [started] = await ownerSql()<{ secret: string }[]>`
      select secret from auth_mfa_factors where auth_user_id = ${other}
    `;
    await confirmEnrolment(ownerSql(), other, await unusedCode(started!.secret, other));

    const own = await as(other, async (tx) => {
      const [row] = await tx<{ total: number }[]>`
        select app.unused_recovery_code_count(${other}::uuid) as total
      `;
      return row!.total;
    });
    expect(own).toBe(10);

    // "How much recovery does that administrator have left" is not a question
    // one colleague should be able to ask about another.
    const theirs = await as(org.adminUserId, async (tx) => {
      const [row] = await tx<{ total: number }[]>`
        select app.unused_recovery_code_count(${other}::uuid) as total
      `;
      return row!.total;
    });
    expect(theirs).toBe(0);
  });
});
