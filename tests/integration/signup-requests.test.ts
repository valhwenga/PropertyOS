/**
 * Asking Spike for an account.
 *
 * Every organisation that existed before this was typed in by a Spike
 * operator, so a landlord who found the product had no way to say so. What is
 * under test is the shape of the answer rather than the form: this is a
 * REQUEST and not a sign-up, because with no email provider an address here is
 * unproven and with no payment provider an account costs nothing to open.
 * Unattended creation on those terms is a way to fill the database with
 * plausible rubbish, so the public write produces a queue row and the only
 * thing that makes an organisation is the provisioning path an operator runs.
 *
 * The tests therefore pin three things: the public write reaches the table
 * through the security-definer function and nothing else; the queue is
 * Spike's alone; and approving is provisioning, with the same invitation and
 * the same audit entry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withAnonymous } from '@propertyos/db';
import {
  approveSignupRequest, declineSignupRequest, listSignupRequests, requestAccess, suggestSlug,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

async function createPlatformOperator(name: string): Promise<string> {
  const authUserId = await createAuthUser(name);
  await ownerSql()`
    update user_profiles set is_platform_operator = true
     where auth_user_id = ${authUserId}
  `;
  // An operator made by flipping the boolean holds everything, which is what
  // migration 0072 backfilled every operator that already existed to.
  await ownerSql()`
    insert into platform_operator_roles (auth_user_id, role_key)
    values (${authUserId}, 'platform_admin') on conflict do nothing
  `;
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

describe('Requests for an account', () => {
  let operator: string;
  let outsider: OrganisationFixture;
  let stamp: string;

  beforeAll(async () => {
    operator = await createPlatformOperator('Spike Intake');
    outsider = await createOrganisation('Unrelated Co');
    stamp = Date.now().toString(36);
  });

  afterAll(async () => { await closeOwner(); });

  it('takes a request from somebody with no account at all', async () => {
    const { requestId } = await withAnonymous((tx) =>
      requestAccess(tx, {
        organisationName: `Mahlangu Lettings ${stamp}`,
        contactName: 'Thandi Mahlangu',
        contactEmail: `thandi-${stamp}@example.invalid`,
        contactPhone: '082 555 0100',
        portfolioSize: 34,
        note: 'Moving off spreadsheets before the new financial year.',
      }),
    );
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const queue = await asPlatformOperator(operator, (tx) =>
      listSignupRequests(tx, operator, { status: 'requested' }),
    );
    const mine = queue.find((r) => r.id === requestId)!;
    expect(mine.contactEmail).toBe(`thandi-${stamp}@example.invalid`);
    expect(mine.portfolioSize).toBe(34);
    // An address is offered, not chosen: the operator still decides, and a
    // suggestion that is already somebody's is never offered as-is.
    expect(mine.suggestedSlug).toBe(suggestSlug(`Mahlangu Lettings ${stamp}`));
  });

  it('refuses a second open request from the same address', async () => {
    const email = `twice-${stamp}@example.invalid`;
    await withAnonymous((tx) =>
      requestAccess(tx, {
        organisationName: 'Patience Properties',
        contactName: 'Patience Dube',
        contactEmail: email,
      }),
    );
    await expect(
      withAnonymous((tx) =>
        requestAccess(tx, {
          organisationName: 'Patience Properties',
          contactName: 'Patience Dube',
          contactEmail: email,
        }),
      ),
    ).rejects.toThrow(/already have a request/i);
  });

  it('leaves the queue unreadable to a landlord, and unwritable by anybody', async () => {
    // A customer's own administrator is nobody here: the queue is Spike's.
    const seen = await as(outsider.adminUserId, (tx) =>
      tx`select id from signup_requests`,
    );
    expect(seen).toHaveLength(0);

    // And there is no second path to the table on the application role, which
    // is the role every request runs as: it holds no INSERT grant at all, so
    // the security-definer function is the only way a row appears. (The
    // privileged connection provisioning runs on is the owner and bypasses
    // grants, which is exactly why this is asserted on the ordinary one.)
    await expect(
      as(operator, (tx) => tx`
        insert into signup_requests (organisation_name, contact_name, contact_email)
        values ('Back Door', 'Nobody', 'nobody@example.invalid')
      `),
    ).rejects.toThrow(/permission denied/i);
  });

  it('turns an approved request into an organisation, through the ordinary path', async () => {
    const email = `approved-${stamp}@example.invalid`;
    const { requestId } = await withAnonymous((tx) =>
      requestAccess(tx, {
        organisationName: `Highveld Rentals ${stamp}`,
        contactName: 'Sipho Khumalo',
        contactEmail: email,
      }),
    );

    const slug = `highveld-${stamp}`;
    const approved = await asPlatformOperator(operator, (tx) =>
      approveSignupRequest(tx, operator, {
        requestId,
        slug,
        planKey: 'portfolio',
        legalEntityName: 'Highveld Rentals (Pty) Ltd',
      }),
    );
    expect(approved.token).toHaveLength(43);

    // Provisioned the way /platform/new provisions: an organisation with
    // nobody in it, and an invitation to the person who asked.
    const [organisation] = await ownerSql()<{ slug: string }[]>`
      select slug from organisations where id = ${approved.organisationId}
    `;
    expect(organisation!.slug).toBe(slug);
    const members = await ownerSql()`
      select 1 from memberships where organisation_id = ${approved.organisationId}
    `;
    expect(members).toHaveLength(0);
    const [invitation] = await ownerSql()<{ invited_email: string }[]>`
      select invited_email::text from staff_invitations
       where organisation_id = ${approved.organisationId}
    `;
    expect(invitation!.invited_email).toBe(email);

    // The request records what it became, and cannot be decided twice.
    const decided = await asPlatformOperator(operator, (tx) =>
      listSignupRequests(tx, operator, { status: 'provisioned' }),
    );
    expect(decided.find((r) => r.id === requestId)?.organisationId)
      .toBe(approved.organisationId);

    await expect(
      asPlatformOperator(operator, (tx) =>
        approveSignupRequest(tx, operator, {
          requestId, slug: `${slug}-again`, planKey: 'portfolio',
          legalEntityName: 'Highveld Rentals (Pty) Ltd',
        }),
      ),
    ).rejects.toThrow(/already been decided/i);
  });

  it('keeps a declined request, with the reason and nothing sent', async () => {
    const { requestId } = await withAnonymous((tx) =>
      requestAccess(tx, {
        organisationName: `Duplicate Co ${stamp}`,
        contactName: 'Jan Pretorius',
        contactEmail: `declined-${stamp}@example.invalid`,
      }),
    );

    await asPlatformOperator(operator, (tx) =>
      declineSignupRequest(tx, operator, {
        requestId, reason: 'Already a customer under another name.',
      }),
    );

    const declined = await asPlatformOperator(operator, (tx) =>
      listSignupRequests(tx, operator, { status: 'declined' }),
    );
    const row = declined.find((r) => r.id === requestId)!;
    expect(row.declineReason).toBe('Already a customer under another name.');
    expect(row.organisationId).toBeNull();

    // Nothing was queued to tell them: there is no email provider, so saying
    // so in the console is the honest alternative to a notification that
    // never leaves the building.
    const notified = await ownerSql()`
      select 1 from notifications where body like ${'%' + `Duplicate Co ${stamp}` + '%'}
    `;
    expect(notified).toHaveLength(0);

    // Declining is audited, because "why is this person not a customer" is a
    // question somebody asks six months later.
    const [audit] = await ownerSql()<{ action: string }[]>`
      select action from audit_events
       where resource_type = 'signup_request' and resource_id = ${requestId}::uuid
    `;
    expect(audit!.action).toBe('platform.signup_request_declined');
  });

  it('refuses the whole queue to somebody who is not a platform operator', async () => {
    await expect(
      as(outsider.adminUserId, (tx) => listSignupRequests(tx, outsider.adminUserId)),
    ).rejects.toThrow();
  });
});
