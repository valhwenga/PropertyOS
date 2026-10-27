/**
 * A way back into an account.
 *
 * This is the most dangerous thing in the product: a path that puts somebody
 * into an account they cannot otherwise reach. The tests are therefore mostly
 * about what it REFUSES.
 *
 * What they pin:
 *
 *   1. asking tells the asker nothing — a real address and an unknown one are
 *      recorded identically and answered identically, so the form cannot be
 *      used to find out who has an account;
 *   2. the customer's own administrator can decide it, and a colleague who is
 *      not an administrator, and an administrator of a different landlord,
 *      cannot even see it;
 *   3. Spike cannot see or decide one while the person has an administrator of
 *      their own — asserted on the read, because a rule enforced only in a
 *      policy's WHERE clause is a rule nobody can see working;
 *   4. Spike's route waits: the link does not work until the delay has passed,
 *      and the account holder can kill it with a token that works while they
 *      are still locked out;
 *   5. the link does only what was lost — a forgotten password leaves the
 *      second factor standing — and it is single use.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { withAnonymous } from '@propertyos/db';
import { privilegedSql } from '@propertyos/db/client';
import {
  approveRecoveryAsAdministrator, approveRecoveryAsSpike, cancelRecoveryWithToken,
  completeRecovery, describeRecoveryLink, listRecoveryRequests, requestAccountRecovery,
} from '@propertyos/domain';
import {
  addMember, as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation,
  ownerSql, type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string, roles: string[]): Promise<string> {
  const authUserId = await createAuthUser(name, {
    platformOperator: true, platformRoles: roles,
  });
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

async function emailOf(authUserId: string): Promise<string> {
  const [row] = await ownerSql()<{ email: string }[]>`
    select email from auth.users where id = ${authUserId}::uuid
  `;
  return row!.email;
}

/** A verified authenticator and a recovery code, as enrolment leaves them. */
async function enrol(authUserId: string): Promise<void> {
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  await ownerSql()`
    insert into auth_mfa_recovery_codes (auth_user_id, code_hash)
    values (${authUserId}, ${createHash('sha256').update('code-1').digest()})
    on conflict do nothing
  `;
}

async function ask(email: string, lost: 'password' | 'second_factor' | 'both', ipHash?: string) {
  await withAnonymous((tx) => requestAccountRecovery(tx, {
    email, lost, note: 'New phone, old one is gone and I cannot find the codes.',
    ...(ipHash ? { ipHash } : {}),
  }));
  const [row] = await ownerSql()<{ id: string }[]>`
    select id::text from recovery_requests
    where lower(email) = lower(${email}) and status = 'open'
  `;
  return row?.id ?? null;
}

/**
 * As a signed-out person holding a link.
 *
 * The same privileged connection `/join/[token]` runs on, for the same reason:
 * there is no session, and the token is the only credential there is.
 */
async function withLink<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  const sql = privilegedSql();
  return sql.begin(async (tx) => fn(tx as never)) as Promise<T>;
}

describe('getting back into an account', () => {
  let solo: OrganisationFixture;      // one administrator and nobody else
  let staffed: OrganisationFixture;   // two administrators
  let colleague: string;              // the other administrator
  let bystander: string;              // a member who administers nothing
  let otherLandlord: OrganisationFixture;
  let spike: string;

  beforeAll(async () => {
    solo = await createOrganisation('Solo Landlord', { planKey: 'starter' });
    staffed = await createOrganisation('Staffed Letting', { planKey: 'portfolio' });
    otherLandlord = await createOrganisation('Unrelated Props', { planKey: 'starter' });
    spike = await createOperator('Spike Recoverer', ['platform_admin']);

    colleague = await addMember(staffed.organisationId, 'Second Admin', ['org_admin']);
    bystander = await addMember(staffed.organisationId, 'Ordinary Member', ['property_manager']);
    await enrol(solo.adminUserId);
    await enrol(staffed.adminUserId);
    await enrol(colleague);
  });

  afterAll(async () => {
    await ownerSql()`delete from recovery_requests`;
    await closeOwner();
  });

  beforeEach(async () => { await ownerSql()`delete from recovery_requests`; });

  it('answers the same for an address with an account and one without', async () => {
    const real = await emailOf(staffed.adminUserId);
    const made_up = 'nobody.at.all@demo.invalid';

    // Neither call returns anything, and neither raises.
    await expect(ask(real, 'both')).resolves.toBeTruthy();
    await expect(ask(made_up, 'password')).resolves.toBeTruthy();

    // Both recorded; the unknown one carries no person, which is the only
    // difference and is visible to nobody who asked.
    const [unknown] = await ownerSql()<{ auth_user_id: string | null }[]>`
      select auth_user_id::text from recovery_requests where email = ${made_up}
    `;
    expect(unknown?.auth_user_id).toBeNull();

    // Asking twice while one is open does not pile up work for an approver.
    await ask(real, 'both');
    const [count] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from recovery_requests
      where lower(email) = lower(${real}) and status = 'open'
    `;
    expect(Number(count?.count)).toBe(1);

    await ownerSql()`delete from recovery_requests`;
  });

  it('refuses a network that asks all day', async () => {
    const ip = 'rate-limited-network-hash';
    for (let i = 0; i < 5; i += 1) {
      await ask(`person${i}@demo.invalid`, 'password', ip);
    }
    await expect(ask('person6@demo.invalid', 'password', ip))
      .rejects.toThrow(/too many/i);
    await ownerSql()`delete from recovery_requests`;
  });

  it('is visible to the customer own administrator and to nobody else', async () => {
    const requestId = await ask(await emailOf(staffed.adminUserId), 'both');
    expect(requestId).toBeTruthy();

    // The colleague who can tell whether this is really them.
    const theirs = await as(colleague, (tx) => listRecoveryRequests(tx));
    expect(theirs.map((r) => r.id)).toContain(requestId);
    expect(theirs[0]?.personName).toBe('Staffed Letting Admin');
    expect(theirs[0]?.organisations).toContain('Staffed Letting');

    // A member of the same organisation who administers nothing.
    expect(await as(bystander, (tx) => listRecoveryRequests(tx))).toEqual([]);

    // An administrator of an unrelated landlord.
    expect(await as(otherLandlord.adminUserId, (tx) => listRecoveryRequests(tx))).toEqual([]);

    // And Spike, because this person has a colleague. Asserted under the
    // operator's OWN context: `asPlatformOperator` lifts row-level filtering,
    // so asserting it there would have passed whatever the policy said.
    expect(await as(spike, (tx) => listRecoveryRequests(tx))).toEqual([]);
    // And under a lifted read too, which is how some platform pages load:
    // the list the console asks for says the rule in SQL as well.
    expect(await asPlatformOperator(spike, (tx) =>
      listRecoveryRequests(tx, { onlyWithoutAnAdministrator: true }))).toEqual([]);
    await expect(asPlatformOperator(spike, (tx) => approveRecoveryAsSpike(tx, spike, {
      requestId: requestId!,
      reason: 'Spoke to them on the number we hold and confirmed the last invoice total.',
    }))).rejects.toThrow();

    await ownerSql()`delete from recovery_requests`;
  });

  it('lets the administrator approve, and the link resets only the password', async () => {
    const requestId = await ask(await emailOf(staffed.adminUserId), 'password');

    const approval = await as(colleague, (tx) => approveRecoveryAsAdministrator(tx, colleague, {
      requestId: requestId!,
      reason: 'She is at the desk opposite mine and I watched her phone die.',
    }));
    expect(approval.token).toBeTruthy();

    // No waiting period: the approver is the customer, not Spike.
    const link = await withLink((tx) => describeRecoveryLink(tx, { token: approval.token }));
    expect(link.live).toBe(true);
    expect(link.lost).toBe('password');

    const before = await ownerSql()<{ password_hash: string }[]>`
      select password_hash from auth.users where id = ${staffed.adminUserId}::uuid
    `;
    await withLink((tx) => completeRecovery(tx, {
      token: approval.token, newPasswordHash: 'scrypt$newsalt$newhash',
    }));
    const after = await ownerSql()<{ password_hash: string }[]>`
      select password_hash from auth.users where id = ${staffed.adminUserId}::uuid
    `;
    expect(after[0]?.password_hash).toBe('scrypt$newsalt$newhash');
    expect(after[0]?.password_hash).not.toBe(before[0]?.password_hash);

    // A forgotten password is not a lost authenticator: the factor stands,
    // which is the entire point of having one.
    const [factor] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from auth_mfa_factors
      where auth_user_id = ${staffed.adminUserId}::uuid and verified_at is not null
    `;
    expect(Number(factor?.count)).toBe(1);

    // Single use.
    await expect(withLink((tx) => completeRecovery(tx, {
      token: approval.token, newPasswordHash: 'scrypt$again$again',
    }))).rejects.toThrow(/not valid/i);
  });

  it('clears the factor and its codes when that is what was lost', async () => {
    await enrol(colleague);
    const requestId = await ask(await emailOf(colleague), 'second_factor');

    const approval = await as(staffed.adminUserId, (tx) =>
      approveRecoveryAsAdministrator(tx, staffed.adminUserId, {
        requestId: requestId!, reason: 'He is in the office and I saw the broken phone.',
      }));

    // No password needed: that is not what was lost.
    const { lost } = await withLink((tx) => completeRecovery(tx, { token: approval.token }));
    expect(lost).toBe('second_factor');

    const [factors] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from auth_mfa_factors where auth_user_id = ${colleague}::uuid
    `;
    const [codes] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from auth_mfa_recovery_codes where auth_user_id = ${colleague}::uuid
    `;
    expect(Number(factors?.count)).toBe(0);
    expect(Number(codes?.count)).toBe(0);
  });

  it('tells the account holder, and refuses to recover a Spike account', async () => {
    const requestId = await ask(await emailOf(staffed.adminUserId), 'password');
    await as(colleague, (tx) => approveRecoveryAsAdministrator(tx, colleague, {
      requestId: requestId!, reason: 'Rang her and she described the new phone.',
    }));

    // One administrator approving for another IS a takeover if it was not
    // asked for, and what stands against that is the record and the notice.
    const [notice] = await ownerSql()<{ recipient_email: string; title: string }[]>`
      select recipient_email, title from notifications
      where recipient_user_id = ${staffed.adminUserId}::uuid
      order by created_at desc limit 1
    `;
    expect(notice?.recipient_email).toBe(await emailOf(staffed.adminUserId));
    expect(notice?.title).toMatch(/recovery was approved/i);

    // And a customer's administrator cannot reach a Spike account, even if one
    // were somehow a member of their organisation.
    await ownerSql()`
      insert into memberships (organisation_id, auth_user_id, status)
      values (${staffed.organisationId}::uuid, ${spike}::uuid, 'active')
      on conflict do nothing
    `;
    const operatorRequest = await ask(await emailOf(spike), 'both');
    await expect(as(colleague, (tx) => approveRecoveryAsAdministrator(tx, colleague, {
      requestId: operatorRequest!, reason: 'He says he lost his phone as well.',
    }))).rejects.toThrow(/Spike staff/i);
    await ownerSql()`
      delete from memberships
      where organisation_id = ${staffed.organisationId}::uuid and auth_user_id = ${spike}::uuid
    `;
  });

  it('lets Spike decide only for somebody with nobody else, and makes it wait', async () => {
    const requestId = await ask(await emailOf(solo.adminUserId), 'both');

    // Now it IS Spike's to decide, and both the policy and the query show it.
    expect((await as(spike, (tx) => listRecoveryRequests(tx))).map((r) => r.id))
      .toContain(requestId);
    const seen = await asPlatformOperator(spike, (tx) =>
      listRecoveryRequests(tx, { onlyWithoutAnAdministrator: true }));
    expect(seen.map((r) => r.id)).toContain(requestId);
    expect(seen.find((r) => r.id === requestId)?.otherAdminExists).toBe(false);

    // A reason that is not evidence is refused.
    await expect(asPlatformOperator(spike, (tx) => approveRecoveryAsSpike(tx, spike, {
      requestId: requestId!, reason: 'He asked me to',
    }))).rejects.toThrow(/how you established/i);

    const approval = await asPlatformOperator(spike, (tx) =>
      approveRecoveryAsSpike(tx, spike, {
        requestId: requestId!,
        reason: 'Called the number on the account, confirmed the last two invoice totals '
          + 'and the address of the Karoo property.',
      }));
    expect(approval.cancelToken).toBeTruthy();

    // It does not work yet, and says when it will.
    const link = await withLink((tx) => describeRecoveryLink(tx, { token: approval.token }));
    expect(link.live).toBe(false);
    expect(new Date(link.effectiveAt).getTime()).toBeGreaterThan(Date.now());
    await expect(withLink((tx) => completeRecovery(tx, {
      token: approval.token, newPasswordHash: 'scrypt$x$y',
    }))).rejects.toThrow(/not valid/i);

    // The account holder, still locked out, stops it.
    await withLink((tx) => cancelRecoveryWithToken(tx, { cancelToken: approval.cancelToken! }));

    const [row] = await ownerSql()<{ status: string }[]>`
      select status from recovery_requests where id = ${requestId}::uuid
    `;
    expect(row?.status).toBe('cancelled');

    // And the link is dead rather than merely early.
    await expect(withLink((tx) => describeRecoveryLink(tx, { token: approval.token })))
      .rejects.toThrow(/not valid/i);
  });

  it('works once the wait has passed', async () => {
    const requestId = await ask(await emailOf(solo.adminUserId), 'password');
    const approval = await asPlatformOperator(spike, (tx) =>
      approveRecoveryAsSpike(tx, spike, {
        requestId: requestId!,
        reason: 'Called the number on the account and confirmed the last invoice total.',
      }));

    // The wait, served.
    await ownerSql()`
      update recovery_requests set effective_at = now() - interval '1 minute'
      where id = ${requestId}::uuid
    `;
    await withLink((tx) => completeRecovery(tx, {
      token: approval.token, newPasswordHash: 'scrypt$waited$hash',
    }));

    const [user] = await ownerSql()<{ password_hash: string }[]>`
      select password_hash from auth.users where id = ${solo.adminUserId}::uuid
    `;
    expect(user?.password_hash).toBe('scrypt$waited$hash');

    // The whole of it is in the trail: who approved, why, and that it was used.
    const actions = await ownerSql()<{ action: string }[]>`
      select action from audit_events
      where resource_id = ${requestId}::uuid order by occurred_at
    `;
    expect(actions.map((a) => a.action)).toEqual(['recovery.approved', 'recovery.completed']);
  });
});
