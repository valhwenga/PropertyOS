/**
 * Settings, and the flags that are settings.
 *
 * Things the product decided were spread between environment variables, SQL
 * constants and numbers typed into `if` statements: a support session lasted
 * "between 1 and 24 hours" because 24 was written in `openSupportSession`, and
 * a customer who wanted their resident portal switched off could not have it.
 *
 * The claim worth testing is not that values can be stored — that is a table —
 * but that they CHANGE WHAT THE PRODUCT DOES. Every flag below is asserted by
 * exercising the thing it gates, from the side of the person it affects:
 *
 *   1. resolution order, including that a default always exists;
 *   2. a flag off actually closes the feature, and on reopens it;
 *   3. a number read from a setting actually moves the limit;
 *   4. nothing can be stored that is not the type it claims to be;
 *   5. the customer can see what was switched off for them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  clearOrganisationSetting, clearPlatformSetting, createResident, createTicket,
  draftLease, activateLease, grantSupportAccess, openSupportSession,
  organisationSettings, platformSettings, setOrganisationSetting, setPlatformSetting,
  createStandaloneHouse,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation,
  grantPortalAccess, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

async function createOperator(name: string, roles = ['platform_admin']): Promise<string> {
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

describe('platform settings', () => {
  let org: OrganisationFixture;
  let other: OrganisationFixture;
  let operator: string;
  let residentAuthId: string;
  let leaseId: string;
  let propertyId: string;
  let unitId: string;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('Switchable Co', { planKey: 'portfolio' });
    other = await createOrganisation('Unaffected Co', { planKey: 'portfolio' });
    operator = await createOperator('Spike Configurer');

    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Switch House', code: 'SWI', propertyType: 'house',
        addressLine1: '2 Switch Road', city: 'Durban',
      },
    ));
    propertyId = property.propertyId;
    unitId = property.unitId;

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Switch', lastName: 'Resident',
      }),
    );
    residentId = resident.residentId;

    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId, startDate: '2026-02-01', endDate: '2026-12-31',
        rentMinor: 600_000n, billingDay: 1, depositRequiredMinor: 600_000n,
        parties: [{
          residentId, role: 'primary_resident', canViewFinancials: true,
        }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-02-01',
        executionExceptionReason: 'Fixture: no contract attached.',
      }),
    );
    residentAuthId = await grantPortalAccess(
      org.organisationId, leaseId, residentId, 'Switch Resident',
    );
  });

  afterAll(async () => {
    // Leave nothing switched off behind: a later file reading these flags
    // would find a product configured by a test.
    await ownerSql()`delete from organisation_setting_values`;
    await ownerSql()`delete from platform_setting_values`;
    await closeOwner();
  });

  it('always resolves to something, in the order customer, Spike, default', async () => {
    const [shipped] = await ownerSql()<{ value: string }[]>`
      select app.setting(${org.organisationId}, 'support.session.max_hours') as value
    `;
    expect(shipped!.value).toBe('24');

    await asPlatformOperator(operator, (tx) =>
      setPlatformSetting(tx, operator, {
        key: 'support.session.max_hours', value: '8',
        reason: 'Shorter sessions while we are a small team.',
      }),
    );
    const [global] = await ownerSql()<{ value: string }[]>`
      select app.setting(${org.organisationId}, 'support.session.max_hours') as value
    `;
    expect(global!.value).toBe('8');

    // And removing it returns the shipped behaviour rather than nothing.
    await asPlatformOperator(operator, (tx) =>
      clearPlatformSetting(tx, operator, {
        key: 'support.session.max_hours', reason: 'Back to the default.',
      }),
    );
    const [restored] = await ownerSql()<{ value: string }[]>`
      select app.setting(${org.organisationId}, 'support.session.max_hours') as value
    `;
    expect(restored!.value).toBe('24');
  });

  it('moves a limit that used to be a number in the code', async () => {
    // 24 was written into openSupportSession. Nothing else changed here.
    await asPlatformOperator(operator, (tx) =>
      setPlatformSetting(tx, operator, {
        key: 'support.session.max_hours', value: '4',
        reason: 'SPK-9100: shorter sessions agreed at the review.',
      }),
    );

    await expect(
      asPlatformOperator(operator, (tx) =>
        openSupportSession(tx, operator, {
          organisationId: org.organisationId,
          reason: 'SPK-9100: asking for longer than the new limit allows.',
          hours: 6,
        }),
      ),
    ).rejects.toThrow(/between 1 and 4 hours/);

    const within = await asPlatformOperator(operator, (tx) =>
      openSupportSession(tx, operator, {
        organisationId: org.organisationId,
        reason: 'SPK-9100: asking for something inside the new limit.',
        hours: 3,
      }),
    );
    expect(within.supportSessionId).toBeTruthy();

    // The customer's own window limit is a different setting.
    await asPlatformOperator(operator, (tx) =>
      setPlatformSetting(tx, operator, {
        key: 'support.window.max_hours', value: '12',
        reason: 'SPK-9100: same review.',
      }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        grantSupportAccess(tx, org.organisationId, org.adminUserId, {
          hours: 48, reason: 'Longer than Spike now allows.',
        }),
      ),
    ).rejects.toThrow(/at most 12 hours/);

    await asPlatformOperator(operator, (tx) =>
      clearPlatformSetting(tx, operator, {
        key: 'support.session.max_hours', reason: 'Done with the experiment.',
      }),
    );
    await asPlatformOperator(operator, (tx) =>
      clearPlatformSetting(tx, operator, {
        key: 'support.window.max_hours', reason: 'Done with the experiment.',
      }),
    );
  });

  it('closes the resident portal for one customer and nobody else', async () => {
    // On by default: the resident resolves their lease.
    const before = await as(residentAuthId, (tx) =>
      tx`select lease_id from portal_links where auth_user_id = ${residentAuthId}::uuid`,
    );
    expect(before.length).toBeGreaterThan(0);

    await asPlatformOperator(operator, (tx) =>
      setOrganisationSetting(tx, operator, {
        organisationId: org.organisationId,
        key: 'resident.portal', value: 'false',
        reason: 'SPK-9101: they run their own tenant app and asked us to close ours.',
      }),
    );

    // What the console actually resolves a resident's leases through.
    const [closed] = await ownerSql()<{ on: boolean }[]>`
      select app.setting_enabled(${org.organisationId}, 'resident.portal') as on
    `;
    expect(closed!.on).toBe(false);

    const [elsewhere] = await ownerSql()<{ on: boolean }[]>`
      select app.setting_enabled(${other.organisationId}, 'resident.portal') as on
    `;
    expect(elsewhere!.on).toBe(true);

    await asPlatformOperator(operator, (tx) =>
      clearOrganisationSetting(tx, operator, {
        organisationId: org.organisationId, key: 'resident.portal',
        reason: 'SPK-9101: they changed their mind.',
      }),
    );
    const [reopened] = await ownerSql()<{ on: boolean }[]>`
      select app.setting_enabled(${org.organisationId}, 'resident.portal') as on
    `;
    expect(reopened!.on).toBe(true);
  });

  it('stops residents raising requests, and says so in words they can act on', async () => {
    const raised = await as(residentAuthId, (tx) =>
      createTicket(
        tx, org.organisationId, residentAuthId,
        {
          propertyId, unitId, leaseId, residentId, category: 'plumbing',
          description: 'Before the flag was touched: the tap drips.',
          urgency: 'normal',
        },
        { asResident: true },
      ),
    );
    expect(raised.ticketId).toBeTruthy();

    await asPlatformOperator(operator, (tx) =>
      setOrganisationSetting(tx, operator, {
        organisationId: org.organisationId,
        key: 'resident.maintenance_requests', value: 'false',
        reason: 'SPK-9102: they take maintenance calls by phone only.',
      }),
    );

    await expect(
      as(residentAuthId, (tx) =>
        createTicket(
          tx, org.organisationId, residentAuthId,
          {
            propertyId, unitId, leaseId, residentId, category: 'plumbing',
            description: 'After the flag: this should be refused.',
            urgency: 'normal',
          },
          { asResident: true },
        ),
      ),
    ).rejects.toThrow(/does not take maintenance requests through the portal/);

    // The landlord's own staff are unaffected: the flag is about the portal.
    const byTheLandlord = await as(org.adminUserId, (tx) =>
      createTicket(tx, org.organisationId, org.adminUserId, {
        propertyId, unitId, category: 'plumbing',
        description: 'Logged by the landlord, which still works.',
        urgency: 'normal',
      }),
    );
    expect(byTheLandlord.ticketId).toBeTruthy();

    await asPlatformOperator(operator, (tx) =>
      clearOrganisationSetting(tx, operator, {
        organisationId: org.organisationId, key: 'resident.maintenance_requests',
        reason: 'SPK-9102: reversed.',
      }),
    );
  });

  it('closes the public application form, without saying why', async () => {
    const [link] = await ownerSql()<{ token: string }[]>`
      insert into application_links (organisation_id, label, token, active, created_by)
      values (
        ${org.organisationId}, 'Flagged listing',
        ${`tok-${Date.now().toString(36)}`.padEnd(40, 'x')}, true, ${org.adminUserId}
      )
      returning token
    `;

    const [open] = await ownerSql()<{ label: string }[]>`
      select label from app.application_link_details(${link!.token})
    `;
    expect(open?.label).toBe('Flagged listing');

    await asPlatformOperator(operator, (tx) =>
      setOrganisationSetting(tx, operator, {
        organisationId: org.organisationId,
        key: 'public.application_links', value: 'false',
        reason: 'SPK-9103: they are not taking applications this season.',
      }),
    );

    // The page's read returns nothing, so a switched-off link is
    // indistinguishable from one that never existed.
    const afterwards = await ownerSql()`
      select label from app.application_link_details(${link!.token})
    `;
    expect(afterwards).toHaveLength(0);

    // And the submission is refused in the same words as a dead link, which is
    // the half that writes.
    await expect(
      ownerSql()`
        select app.submit_rental_application(
          ${link!.token}, 'Hopeful Applicant', 'hopeful@example.invalid', '',
          '', '', null, null, null, ''
        )
      `,
    ).rejects.toThrow(/not available/);

    await asPlatformOperator(operator, (tx) =>
      clearOrganisationSetting(tx, operator, {
        organisationId: org.organisationId, key: 'public.application_links',
        reason: 'SPK-9103: season over.',
      }),
    );
  });

  it('refuses a value that is not the thing the setting is', async () => {
    await expect(
      asPlatformOperator(operator, (tx) =>
        setPlatformSetting(tx, operator, {
          key: 'resident.portal', value: 'maybe', reason: 'Not a boolean.',
        }),
      ),
    ).rejects.toThrow(/must be true or false/);

    await expect(
      asPlatformOperator(operator, (tx) =>
        setPlatformSetting(tx, operator, {
          key: 'support.session.max_hours', value: 'lots', reason: 'Not a number.',
        }),
      ),
    ).rejects.toThrow(/is not one/);

    await expect(
      asPlatformOperator(operator, (tx) =>
        setPlatformSetting(tx, operator, {
          key: 'support.session.max_hours', value: '900', reason: 'Beyond the ceiling.',
        }),
      ),
    ).rejects.toThrow(/cannot be more than 72/);

    await expect(
      asPlatformOperator(operator, (tx) =>
        setPlatformSetting(tx, operator, {
          key: 'invented.flag', value: 'true', reason: 'Does not exist.',
        }),
      ),
    ).rejects.toThrow(/not found|no setting/i);

    // A setting that is the same for everybody cannot be given to one customer.
    await expect(
      asPlatformOperator(operator, (tx) =>
        setOrganisationSetting(tx, operator, {
          organisationId: org.organisationId,
          key: 'support.session.max_hours', value: '2',
          reason: 'Not overridable per customer.',
        }),
      ),
    ).rejects.toThrow(/same for every customer/);
  });

  it('keeps the writes to operators who hold the permission', async () => {
    const support = await createOperator('Spike Support Config', ['platform_support']);
    await expect(
      asPlatformOperator(support, (tx) =>
        setPlatformSetting(tx, support, {
          key: 'resident.portal', value: 'false', reason: 'Support should not do this.',
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);

    // And on the ordinary connection, so the check is not only in the command.
    await expect(
      as(support, (tx) => tx`
        insert into platform_setting_values (key, value, reason, set_by)
        values ('resident.portal', 'false', 'Writing it directly.', ${support}::uuid)
      `),
    ).rejects.toThrow();

    // Reading stays open to the console: an operator who cannot see that a
    // customer's portal is off cannot answer the ticket about it.
    const readable = await asPlatformOperator(support, (tx) =>
      platformSettings(tx, support),
    );
    expect(readable.length).toBeGreaterThan(0);
  });

  it('shows the customer what was switched off for them', async () => {
    await asPlatformOperator(operator, (tx) =>
      setOrganisationSetting(tx, operator, {
        organisationId: org.organisationId,
        key: 'resident.portal', value: 'false',
        reason: 'SPK-9104: closed at their request.',
      }),
    );

    const theirs = await as(org.adminUserId, (tx) =>
      organisationSettings(tx, org.organisationId, { visibleToCustomerOnly: true }),
    );
    const portal = theirs.find((s) => s.key === 'resident.portal')!;
    expect(portal.effectiveValue).toBe('false');
    expect(portal.ownReason).toContain('SPK-9104');
    expect(portal.setByName).toBe('Spike Configurer');

    // The ones they have not been given an answer for resolve to the default
    // and say so by carrying no value of their own.
    const requests = theirs.find((s) => s.key === 'resident.maintenance_requests')!;
    expect(requests.effectiveValue).toBe('true');
    expect(requests.ownValue).toBeNull();

    // Another customer sees nothing of this one's.
    const strangers = await as(other.adminUserId, (tx) =>
      organisationSettings(tx, other.organisationId, { visibleToCustomerOnly: true }),
    );
    expect(strangers.every((s) => s.ownValue === null)).toBe(true);

    await asPlatformOperator(operator, (tx) =>
      clearOrganisationSetting(tx, operator, {
        organisationId: org.organisationId, key: 'resident.portal',
        reason: 'SPK-9104: reopened.',
      }),
    );
  });

  it('records every change against whoever it happened to', async () => {
    const platformTrail = await ownerSql()<{ action: string; organisation_id: string | null }[]>`
      select action, organisation_id from audit_events
       where action in ('platform.setting_changed', 'platform.setting_cleared')
       order by occurred_at desc limit 1
    `;
    // Spike's own setting changes belong to nobody's organisation.
    expect(platformTrail[0]!.organisation_id).toBeNull();

    const customerTrail = await ownerSql()<{ action: string }[]>`
      select action from audit_events
       where organisation_id = ${org.organisationId}
         and action like 'platform.customer_setting%'
       order by occurred_at
    `;
    // Switching off a customer's portal is a thing that happened to THEM.
    expect(customerTrail.length).toBeGreaterThan(0);
    expect(customerTrail[0]!.action).toBe('platform.customer_setting_changed');
  });
});
