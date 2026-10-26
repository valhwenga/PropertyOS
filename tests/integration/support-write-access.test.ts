/**
 * A support session that can do what the customer asked for.
 *
 * Support sessions were read-only from the day they were built, which was the
 * right default and the wrong end state: a landlord who writes "the ticket for
 * 12B is on the wrong unit, please move it" could not be helped. Spike saw the
 * mistake and could not touch it, so the answer was a list of instructions for
 * the customer to carry out themselves.
 *
 * What these tests pin, in order of how much it would cost to get wrong:
 *
 *   1. Spike can act — but ONLY within a scope the customer chose, and the
 *      customer chooses it at approval, not the operator at request.
 *   2. Money and governance are unreachable under ANY scope: no policy on
 *      those tables mentions support sessions, so the write is refused by the
 *      row and not by a check somebody can forget.
 *   3. Revoking and expiry stop the writing immediately, because a control you
 *      cannot exercise is not a control.
 *   4. Everything done under a session is attributed to it without the command
 *      knowing anything about sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  approveSupportSession, createResident, createStandaloneHouse, createTicket,
  grantSupportAccess, openSupportSession, revokeSupportAccessGrant, supportAccessState,
  supportScopes, transitionTicket,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string): Promise<string> {
  const authUserId = await createAuthUser(name, { platformOperator: true });
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

describe('a support session that can act', () => {
  let org: OrganisationFixture;
  let operator: string;
  let propertyId: string;
  let unitId: string;

  beforeAll(async () => {
    org = await createOrganisation('Helpdesk Co', { planKey: 'portfolio' });
    operator = await createOperator('Spike Helper');
    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Helpdesk House', code: 'HLP', propertyType: 'house',
        addressLine1: '3 Helpdesk Way', city: 'Cape Town',
      },
    ));
    propertyId = property.propertyId;
    unitId = property.unitId;
  });

  afterAll(async () => { await closeOwner(); });

  /** A window the customer opens, carrying the scopes named. */
  async function openWindow(scopes: string[], reason = 'Ticket SPK-1: please fix this.') {
    return as(org.adminUserId, (tx) =>
      grantSupportAccess(tx, org.organisationId, org.adminUserId, {
        hours: 4, reason, scopes,
      }),
    );
  }

  async function closeEverything() {
    await ownerSql()`
      update support_access_grants set revoked_at = now()
       where organisation_id = ${org.organisationId} and revoked_at is null
    `;
    await ownerSql()`
      update support_sessions set revoked_at = now()
       where organisation_id = ${org.organisationId} and revoked_at is null
    `;
  }

  it('offers the customer scopes written for them to read', async () => {
    const scopes = await as(org.adminUserId, (tx) => supportScopes(tx));
    expect(scopes.map((s) => s.key)).toEqual(['maintenance', 'records', 'documents']);
    // The words matter: this is the sentence somebody ticks a box next to.
    expect(scopes[0]!.description).toContain('maintenance tickets');
    expect(scopes[1]!.description).toContain('Cannot end a tenancy');
  });

  it('lets Spike fix the thing the customer asked about', async () => {
    await closeEverything();
    await openWindow(['maintenance']);

    const session = await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-1: moving the kitchen leak to the right unit.',
        hours: 2,
        scopes: ['maintenance'],
      }),
    );
    expect(session.approved).toBe(true);
    expect(session.scopes).toEqual(['maintenance']);

    // The operator now does the work, through the ORDINARY command. Nothing in
    // `createTicket` knows what a support session is.
    const ticket = await as(operator, (tx) =>
      createTicket(tx, org.organisationId, operator, {
        propertyId, unitId, category: 'plumbing',
        description: 'Raised by Spike support on the customer’s behalf: kitchen leak.',
        urgency: 'normal',
      }),
    );
    expect(ticket.ticketId).toBeTruthy();

    const moved = await as(operator, (tx) =>
      transitionTicket(tx, org.organisationId, operator, {
        ticketId: ticket.ticketId, to: 'triaged',
        note: 'Triaged by Spike support, at the customer’s request.',
      }),
    );
    expect(moved.to).toBe('triaged');

    // And it is attributed to the session, which no command passed.
    const [audit] = await ownerSql()<{ support_session_id: string | null }[]>`
      select support_session_id from audit_events
       where organisation_id = ${org.organisationId}
         and resource_id = ${ticket.ticketId}::uuid
       order by occurred_at
       limit 1
    `;
    expect(audit!.support_session_id).toBe(session.supportSessionId);

    // The customer's own screen says what it allowed, in their words.
    const state = await as(org.adminUserId, (tx) =>
      supportAccessState(tx, org.organisationId),
    );
    expect(state.live[0]!.scopes).toEqual(['maintenance']);
    expect(state.live[0]!.readOnly).toBe(false);
    expect(state.live[0]!.actionsRecorded).toBeGreaterThan(0);
  });

  it('refuses the work a neighbouring scope would have allowed', async () => {
    await closeEverything();
    await openWindow(['maintenance']);
    await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-2: maintenance only, this time.',
        hours: 2,
        scopes: ['maintenance'],
      }),
    );

    // `records` was not given, so a resident cannot be created even though the
    // session is live and writing tickets happily.
    await expect(
      as(operator, (tx) =>
        createResident(tx, org.organisationId, operator, {
          firstName: 'Should', lastName: 'Not Exist',
        }),
      ),
    ).rejects.toThrow();
  });

  it('gives an operator no more than the window carries, however much they ask', async () => {
    await closeEverything();
    await openWindow(['maintenance']);

    const session = await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-3: asking for everything, to see what happens.',
        hours: 2,
        scopes: ['maintenance', 'records', 'documents'],
      }),
    );
    // The intersection, not the request.
    expect(session.scopes).toEqual(['maintenance']);

    await expect(
      as(operator, (tx) =>
        createResident(tx, org.organisationId, operator, {
          firstName: 'Still', lastName: 'Not Allowed',
        }),
      ),
    ).rejects.toThrow();
  });

  it('cannot widen itself after the customer approved it', async () => {
    await closeEverything();
    await openWindow(['maintenance', 'records']);
    const session = await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-4: approved for maintenance only.',
        hours: 2,
        scopes: ['maintenance'],
      }),
    );

    // The operator holds the session and the window carries `records`. The
    // guard still refuses: what a session may do is settled at approval.
    await expect(
      as(operator, (tx) => tx`
        update support_sessions set scopes = array['maintenance','records'], read_only = false
         where id = ${session.supportSessionId}::uuid
      `),
    ).rejects.toThrow(/cannot change once approved/i);
  });

  it('refuses a session scoped beyond any window the customer opened', async () => {
    await closeEverything();
    // No window at all: a request is read-only until the customer answers it,
    // whatever the operator asks for.
    const session = await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-5: asking with nothing open.',
        hours: 2,
        scopes: ['records'],
      }),
    );
    expect(session.approved).toBe(false);
    expect(session.scopes).toEqual([]);

    // And the raw insert is refused by the policy, not merely narrowed by the
    // command — the operator cannot write themselves a scoped session.
    await expect(
      as(operator, (tx) => tx`
        insert into support_sessions (
          organisation_id, operator_user_id, reason, expires_at, read_only, scopes,
          approved_at, authorised_by
        ) values (
          ${org.organisationId}, ${operator}::uuid,
          'Writing my own approval, which should be impossible.',
          now() + interval '1 hour', false, array['records'], now(), ${operator}::uuid
        )
      `),
    ).rejects.toThrow();
  });

  it('lets the customer answer a request with the scopes THEY choose', async () => {
    await closeEverything();
    const session = await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-6: I need to correct the unit on a lease.',
        hours: 3,
        scopes: ['records', 'documents'],
      }),
    );
    expect(session.scopes).toEqual([]);

    // They read the request and grant less than was asked for.
    await as(org.adminUserId, (tx) =>
      approveSupportSession(tx, org.adminUserId, {
        supportSessionId: session.supportSessionId,
        scopes: ['records'],
      }),
    );

    const resident = await as(operator, (tx) =>
      createResident(tx, org.organisationId, operator, {
        firstName: 'Corrected', lastName: 'Record',
      }),
    );
    expect(resident.residentId).toBeTruthy();

    // `documents` was asked for and not given.
    await expect(
      as(operator, (tx) => tx`
        insert into documents (
          organisation_id, classification, title, filename, content_type,
          byte_size, content_sha256, storage_key, uploaded_by
        ) values (
          ${org.organisationId}, 'other', 'Not allowed', 'x.pdf', 'application/pdf',
          10, repeat('a', 64), 'nowhere', ${operator}::uuid
        )
      `),
    ).rejects.toThrow();
  });

  it('cannot touch money or governance under any scope', async () => {
    await closeEverything();
    // Every scope the product offers, at once.
    await openWindow(['maintenance', 'records', 'documents']);
    await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-7: everything the customer can possibly give.',
        hours: 2,
        scopes: ['maintenance', 'records', 'documents'],
      }),
    );

    // Where the rent is paid. This is the attack a support channel invites,
    // and no scope reaches it: the table has no support write policy at all.
    await expect(
      as(operator, (tx) => tx`
        insert into bank_accounts (
          organisation_id, label, bank_name, account_number_last4, account_holder
        ) values (
          ${org.organisationId}, 'Mine', 'Fraud Bank', '0000', 'Not The Landlord'
        )
      `),
    ).rejects.toThrow();

    // Permanent access, which would outlive the session that granted it.
    await expect(
      as(operator, (tx) => tx`
        insert into memberships (organisation_id, auth_user_id, status)
        values (${org.organisationId}, ${operator}::uuid, 'active')
      `),
    ).rejects.toThrow();

    // Extending their own access.
    await expect(
      as(operator, (tx) => tx`
        insert into support_access_grants (
          organisation_id, authorised_by, reason, expires_at
        ) values (
          ${org.organisationId}, ${operator}::uuid, 'Letting myself in for longer',
          now() + interval '30 days'
        )
      `),
    ).rejects.toThrow();

    // Money out, and the ledger.
    await expect(
      as(operator, (tx) => tx`
        insert into receipts (
          organisation_id, lease_id, amount_minor, received_on, method, status
        ) values (
          ${org.organisationId}, null, 100000, current_date, 'eft', 'confirmed'
        )
      `),
    ).rejects.toThrow();
  });

  it('stops the moment the customer revokes, and when the window lapses', async () => {
    await closeEverything();
    const window = await openWindow(['maintenance']);
    await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'Ticket SPK-8: about to be revoked.',
        hours: 2,
        scopes: ['maintenance'],
      }),
    );

    const before = await as(operator, (tx) =>
      createTicket(tx, org.organisationId, operator, {
        propertyId, unitId, category: 'other',
        description: 'Written while the session was live, which it is.',
        urgency: 'low',
      }),
    );
    expect(before.ticketId).toBeTruthy();

    // Closing the window deliberately leaves the session alone — that is
    // documented behaviour, asserted in support-approval.test.ts — so the
    // customer's real control is ending the session.
    await as(org.adminUserId, (tx) =>
      revokeSupportAccessGrant(tx, org.adminUserId, { grantId: window.grantId }),
    );
    await ownerSql()`
      update support_sessions set revoked_at = now()
       where organisation_id = ${org.organisationId} and revoked_at is null
    `;

    await expect(
      as(operator, (tx) =>
        createTicket(tx, org.organisationId, operator, {
          propertyId, unitId, category: 'other',
          description: 'Written after the session ended, which must not happen.',
          urgency: 'low',
        }),
      ),
    ).rejects.toThrow();

    // And an expired session is no different from a revoked one.
    await ownerSql()`
      insert into support_sessions (
        organisation_id, operator_user_id, reason, expires_at, read_only, scopes,
        approved_at, authorised_by, granted_at
      ) values (
        ${org.organisationId}, ${operator}, 'Ticket SPK-9: expired an hour ago.',
        now() - interval '1 hour', false, array['maintenance'], now() - interval '2 hours',
        ${org.adminUserId}, now() - interval '3 hours'
      )
    `;
    await expect(
      as(operator, (tx) =>
        createTicket(tx, org.organisationId, operator, {
          propertyId, unitId, category: 'other',
          description: 'Written under an expired session, which must not happen.',
          urgency: 'low',
        }),
      ),
    ).rejects.toThrow();
  });

  it('keeps a scope from carrying a permission it may never carry', async () => {
    // The allowlist, asserted rather than trusted: a later migration adding a
    // scope permission has to pass this constraint, so "support can move
    // money" cannot be introduced by a one-line insert.
    await expect(
      ownerSql()`
        insert into support_scope_permissions (scope_key, permission_key)
        values ('records', 'payment.reverse')
      `,
    ).rejects.toThrow(/support_scope_permissions_grantable/);

    await expect(
      ownerSql()`
        insert into support_scope_permissions (scope_key, permission_key)
        values ('records', 'membership.manage')
      `,
    ).rejects.toThrow(/support_scope_permissions_grantable/);
  });
});
