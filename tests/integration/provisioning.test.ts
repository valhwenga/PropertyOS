/**
 * Setting up a new customer.
 *
 * `createOrganisationWithOwner` has existed since the first migration with no
 * screen, so a new customer could not be set up in the product at all: every
 * organisation that exists was created by the seed or by a test.
 *
 * The decision under test is what Spike does NOT get. The obvious
 * implementation makes the Spike operator the founding administrator and
 * expects somebody to remove them later — a Spike account inside customer
 * data, which is exactly what the support-session machinery exists to avoid.
 * A provisioned organisation therefore starts with NOBODY in it, and its first
 * administrator arrives by accepting an invitation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  acceptStaffInvitation, listCustomers, listPendingCustomers, listStaff,
  provisionCustomer,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

/** A Spike operator with a second factor, which platform administration needs. */
async function createPlatformOperator(name: string): Promise<string> {
  const authUserId = await createAuthUser(name);
  await ownerSql()`
    update user_profiles set is_platform_operator = true
     where auth_user_id = ${authUserId}
  `;
  await ownerSql()`
    insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
    values (${authUserId}, 'totp', 'JBSWY3DPEHPK3PXP', now())
    on conflict (auth_user_id, factor_type) do update set verified_at = now()
  `;
  return authUserId;
}

describe('Customer provisioning', () => {
  let operator: string;
  let outsider: OrganisationFixture;
  let slug: string;

  beforeAll(async () => {
    operator = await createPlatformOperator('Spike Operator');
    outsider = await createOrganisation('Unrelated Co');
    slug = `provisioned-${Date.now().toString(36)}`;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------- who may do this */

  it('refuses anybody who is not a Spike operator', async () => {
    await expect(
      as(outsider.adminUserId, (tx) =>
        provisionCustomer(tx, outsider.adminUserId, {
          name: 'Sneaky Co', slug: 'sneaky-co', legalEntityName: 'Sneaky (Pty) Ltd',
          planKey: 'starter',
          administrator: { fullName: 'Sneak Y', email: 'sneaky@demo.invalid' },
          reason: 'Trying to provision from a customer account.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a non-operator even on the privileged connection', async () => {
    // The case that matters. The ordinary connection refuses the insert by
    // policy anyway; the privileged one does not, so the command's own check
    // is the only thing standing there — and it runs because the claims are
    // set on that transaction too.
    await expect(
      asPlatformOperator(outsider.adminUserId, (tx) =>
        provisionCustomer(tx, outsider.adminUserId, {
          name: 'Escalated Co', slug: 'escalated-co',
          legalEntityName: 'Escalated (Pty) Ltd', planKey: 'starter',
          administrator: { fullName: 'Esc Alated', email: 'esc@demo.invalid' },
          reason: 'A customer account on a privileged connection.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from organisations where slug = 'escalated-co'
    `;
    expect(total).toBe('0');
  });

  it('refuses a Spike operator without a second factor on the session', async () => {
    const operatorAtOneFactor = await createPlatformOperator('One Factor Operator');
    await ownerSql()`
      delete from auth_mfa_factors where auth_user_id = ${operatorAtOneFactor}
    `;
    await expect(
      asPlatformOperator(operatorAtOneFactor, (tx) =>
        provisionCustomer(tx, operatorAtOneFactor, {
          name: 'Half Secured Co', slug: 'half-secured', legalEntityName: 'Half (Pty) Ltd',
          planKey: 'starter',
          administrator: { fullName: 'Half Secure', email: 'half@demo.invalid' },
          reason: 'Platform administration without the second step.',
        }),
      'aal1',
      ),
    ).rejects.toThrow(/second factor/);
  });

  /* ------------------------------------------- Spike is not in what it made */

  it('creates an organisation with nobody in it', async () => {
    const provisioned = await asPlatformOperator(operator, (tx) =>
      provisionCustomer(tx, operator, {
        name: 'Karoo Rentals', slug, legalEntityName: 'Karoo Rentals (Pty) Ltd',
        planKey: 'portfolio',
        administrator: { fullName: 'Lerato Mahlangu', email: 'Lerato@Karoo.invalid' },
        reason: 'Signed up by sales on 16 October; two blocks in Graaff-Reinet.',
      }),
    );
    expect(provisioned.token).toHaveLength(43);

    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from memberships
       where organisation_id = ${provisioned.organisationId}
    `;
    // The whole point. Not "Spike is removed afterwards" — Spike was never in
    // it, so there is nothing to forget to remove.
    expect(total).toBe('0');

    const [{ operator_members }] = await ownerSql()<{ operator_members: string }[]>`
      select count(*)::text as operator_members from memberships
       where auth_user_id = ${operator}
    `;
    expect(operator_members).toBe('0');

    (globalThis as Record<string, unknown>).__provisioned = provisioned;
  });

  it('gives the organisation everything it needs to start work', async () => {
    const provisioned = (globalThis as Record<string, unknown>).__provisioned as {
      organisationId: string;
    };

    const [org] = await ownerSql()<
      { status: string; currency_code: string; time_zone: string }[]
    >`
      select status::text, currency_code, time_zone from organisations
       where id = ${provisioned.organisationId}
    `;
    // Launch defaults, stored explicitly rather than assumed anywhere later.
    expect(org!.status).toBe('trial');
    expect(org!.currency_code).toBe('ZAR');
    expect(org!.time_zone).toBe('Africa/Johannesburg');

    const [counts] = await ownerSql()<
      { books: string; accounts: string; portfolios: string; subs: string }[]
    >`
      select
        (select count(*) from financial_books where organisation_id = ${provisioned.organisationId})::text as books,
        (select count(*) from accounts where organisation_id = ${provisioned.organisationId})::text as accounts,
        (select count(*) from portfolios where organisation_id = ${provisioned.organisationId})::text as portfolios,
        (select count(*) from subscriptions where organisation_id = ${provisioned.organisationId})::text as subs
    `;
    expect(counts!.books).toBe('1');
    expect(Number(counts!.accounts)).toBeGreaterThan(8);
    expect(counts!.portfolios).toBe('1');
    expect(counts!.subs).toBe('1');
  });

  it('records who provisioned it and why, and that Spike is not a member', async () => {
    const provisioned = (globalThis as Record<string, unknown>).__provisioned as {
      organisationId: string;
    };
    const [entry] = await ownerSql()<
      { reason: string | null; after_state: Record<string, unknown> }[]
    >`
      select reason, after_state from audit_events
       where organisation_id = ${provisioned.organisationId}
         and action = 'platform.customer_provisioned'
    `;
    expect(entry!.reason).toContain('Signed up by sales');
    expect(entry!.after_state.spikeMembership).toBe('none');
    expect(entry!.after_state.memberCount).toBe(0);
    expect(entry!.after_state.provisionedBy).toBe('Spike Operator');
  });

  it('keeps the invitation token out of the database and the audit trail', async () => {
    const provisioned = (globalThis as Record<string, unknown>).__provisioned as {
      organisationId: string; token: string;
    };
    const [row] = await ownerSql()<{ token_hash: string | null }[]>`
      select encode(invite_token_hash, 'hex') as token_hash from staff_invitations
       where organisation_id = ${provisioned.organisationId}
    `;
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const entries = await ownerSql()`
      select action, before_state, after_state, reason from audit_events
       where organisation_id = ${provisioned.organisationId}
    `;
    expect(JSON.stringify(entries)).not.toContain(provisioned.token);
  });

  /* -------------------------------------------------- the pending customer */

  it('lists a customer nobody has accepted yet, because nothing else can see it', async () => {
    const pending = await asPlatformOperator(operator, (tx) => listPendingCustomers(tx, operator));
    const ours = pending.find((p) => p.slug === slug)!;

    expect(ours.name).toBe('Karoo Rentals');
    expect(ours.administratorName).toBe('Lerato Mahlangu');
    // Stored lower case, because people type their own address inconsistently.
    expect(ours.administratorEmail).toBe('lerato@karoo.invalid');
    expect(ours.lapsed).toBe(false);
  });

  it('returns nothing on an ordinary connection, which is why the caller lifts it', async () => {
    // Not an error — the rows are simply filtered away, because the operator
    // is a member of nothing. A caller that forgot to lift the filtering would
    // see an empty list and believe it.
    const filtered = await as(operator, (tx) => listPendingCustomers(tx, operator));
    expect(filtered).toHaveLength(0);

    const lifted = await asPlatformOperator(operator, (tx) =>
      listPendingCustomers(tx, operator),
    );
    expect(lifted.length).toBeGreaterThan(0);
  });

  it('does not let a customer account read the pending list', async () => {
    await expect(
      as(outsider.adminUserId, (tx) => listPendingCustomers(tx, outsider.adminUserId)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  /* ------------------------------------------------ the founder arrives */

  it('makes the invited person the administrator when they accept', async () => {
    const provisioned = (globalThis as Record<string, unknown>).__provisioned as {
      organisationId: string; token: string;
    };
    const founder = await createAuthUser('Lerato Mahlangu');

    const accepted = await ownerSql().begin(async (tx) =>
      acceptStaffInvitation(tx as never, {
        token: provisioned.token, authUserId: founder,
      }),
    );
    expect(accepted.organisationId).toBe(provisioned.organisationId);
    expect(accepted.roles).toEqual(['org_admin']);

    const staff = await as(founder, (tx) =>
      listStaff(tx, provisioned.organisationId, founder),
    );
    expect(staff).toHaveLength(1);
    expect(staff[0]!.roles).toEqual(['org_admin']);
    expect(staff[0]!.scope.type).toBe('organisation');
    expect(staff[0]!.isSelf).toBe(true);

    // And still nobody from Spike.
    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from memberships
       where organisation_id = ${provisioned.organisationId}
         and auth_user_id = ${operator}
    `;
    expect(total).toBe('0');

    (globalThis as Record<string, unknown>).__founder = founder;
  });

  it('drops off the pending list once it is accepted', async () => {
    const pending = await asPlatformOperator(operator, (tx) => listPendingCustomers(tx, operator));
    expect(pending.some((p) => p.slug === slug)).toBe(false);
  });

  it('shows the new customer in the ordinary customer list', async () => {
    const customers = await asPlatformOperator(operator, (tx) => listCustomers(tx, operator));
    const ours = customers.find((c) => c.slug === slug)!;
    expect(ours.name).toBe('Karoo Rentals');
    expect(ours.planKey).toBe('portfolio');
    expect(ours.memberCount).toBe(1);
    expect(ours.billableUnits).toBe(0);
  });

  it('lets the founder work in their own organisation and nowhere else', async () => {
    const founder = (globalThis as Record<string, unknown>).__founder as string;
    const provisioned = (globalThis as Record<string, unknown>).__provisioned as {
      organisationId: string;
    };

    const own = await as(founder, (tx) => tx<{ id: string }[]>`
      select id from organisations where id = ${provisioned.organisationId}::uuid
    `);
    expect(own).toHaveLength(1);

    const theirs = await as(founder, (tx) => tx<{ id: string }[]>`
      select id from properties where organisation_id = ${outsider.organisationId}::uuid
    `);
    expect(theirs).toHaveLength(0);
  });

  /* ------------------------------------------------------------- refusals */

  it('refuses an address that is already taken', async () => {
    await expect(
      asPlatformOperator(operator, (tx) =>
        provisionCustomer(tx, operator, {
          name: 'Karoo Rentals Again', slug, legalEntityName: 'Karoo Two (Pty) Ltd',
          planKey: 'starter',
          administrator: { fullName: 'Someone Else', email: 'else@karoo.invalid' },
          reason: 'Second attempt with the same address.',
        }),
      ),
    ).rejects.toThrow(/already taken/);
  });

  it('refuses a plan that does not exist', async () => {
    await expect(
      asPlatformOperator(operator, (tx) =>
        provisionCustomer(tx, operator, {
          name: 'No Plan Co', slug: `no-plan-${Date.now().toString(36)}`,
          legalEntityName: 'No Plan (Pty) Ltd', planKey: 'imaginary',
          administrator: { fullName: 'No Plan', email: 'noplan@demo.invalid' },
          reason: 'A plan nobody sells.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('requires a reason, so the record says why the account exists', async () => {
    await expect(
      asPlatformOperator(operator, (tx) =>
        provisionCustomer(tx, operator, {
          name: 'No Reason Co', slug: `no-reason-${Date.now().toString(36)}`,
          legalEntityName: 'No Reason (Pty) Ltd', planKey: 'starter',
          administrator: { fullName: 'No Reason', email: 'noreason@demo.invalid' },
          reason: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses an address that would not work in a URL', async () => {
    await expect(
      asPlatformOperator(operator, (tx) =>
        provisionCustomer(tx, operator, {
          name: 'Spaces Co', slug: 'Not A Slug', legalEntityName: 'Spaces (Pty) Ltd',
          planKey: 'starter',
          administrator: { fullName: 'Spa Ces', email: 'spaces@demo.invalid' },
          reason: 'An address with spaces in it.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('leaves nothing behind when it refuses', async () => {
    const [{ total }] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from organisations where name like 'No %Co'
    `;
    // A refusal part-way through would otherwise leave an organisation with no
    // administrator and no invitation — invisible to everybody, forever.
    expect(total).toBe('0');
  });
});
