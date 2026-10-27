/**
 * A customer leaving.
 *
 * Closing an account was a column. These tests pin the process that replaced
 * it, and in particular the one irreversible thing in this product.
 *
 * What they pin:
 *
 *   1. closing records why and until when, and `setAccountStatus` can no
 *      longer reach `closed` — a closed account with no retention date is one
 *      nobody can destroy and nobody can answer the customer about;
 *   2. the refusals around destruction, each of which is the only thing
 *      standing between a wrong click and a landlord's tenancy history:
 *      before the date, wrong identifier typed, not an administrator,
 *      not closed, twice;
 *   3. that destruction actually destroys — asserted generically, by asking
 *      the catalogue for every table carrying an organisation_id and
 *      demanding zero rows, so a table added next year is covered by this
 *      test on the day it is added rather than when somebody remembers;
 *   4. that it keeps SPIKE's records: its invoices to the customer, its audit
 *      of its own conduct, and the sessions the customer authorised — while
 *      the customer's own trail goes;
 *   5. that the people are anonymised, and that a person who still belongs
 *      somewhere else is left alone;
 *   6. that a destroyed account cannot be reopened onto an empty console.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  closeCustomer, createResident, createStandaloneHouse, customerClosure,
  destroyCustomerData, listClosures, recordDestroyedObjects, setAccountStatus, setRetention,
} from '@propertyos/domain';
import {
  addMember, as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation,
  grantSupportSession, ownerSql, type OrganisationFixture,
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

/** Every table that carries a customer's organisation_id, from the catalogue. */
async function customerDataTables(): Promise<string[]> {
  const rows = await ownerSql()<{ relname: string }[]>`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attname = 'organisation_id' and a.attnum > 0 and not a.attisdropped
      and c.relname not in (
        'organisation_closures', 'subscription_invoices',
        'support_sessions', 'support_access_grants', 'audit_events'
      )
    order by c.relname
  `;
  return rows.map((r) => r.relname);
}

async function rowsLeftFor(organisationId: string): Promise<Record<string, number>> {
  const sql = ownerSql();
  const left: Record<string, number> = {};
  for (const table of await customerDataTables()) {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text from ${sql(table)} where organisation_id = ${organisationId}::uuid
    `;
    const count = Number(row?.count ?? 0);
    if (count > 0) left[table] = count;
  }
  return left;
}

describe('a customer leaving', () => {
  let org: OrganisationFixture;
  let admin: string;
  let support: string;
  let dualMemberUserId: string;
  let destroyedObjects: string[] = [];

  beforeAll(async () => {
    org = await createOrganisation('Departing Props', { planKey: 'portfolio' });
    admin = await createOperator('Spike Closer', ['platform_admin']);
    support = await createOperator('Spike Helper', ['platform_support']);

    // Enough of a real customer that destruction has something to destroy and
    // something to trip over: a property, a resident, a session the customer
    // authorised, and an invoice of Spike's.
    const property = await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Leaving House', code: 'LEAVE', propertyType: 'house',
        addressLine1: '9 Exit Street', city: 'Durban',
      },
    ));
    await as(org.adminUserId, (tx) => createResident(tx, org.organisationId, org.adminUserId, {
      firstName: 'Thandi', lastName: 'Mokoena', email: 'thandi@demo.invalid',
      phone: '+27821234567',
    }));
    expect(property).toBeTruthy();

    // The customer's own administrator authorising a session: the row whose
    // `authorised_by` is the reason identities are anonymised and not deleted.
    await grantSupportSession(org.organisationId, support, org.adminUserId);

    // Two people, to exercise both sides of the orphan test: one who belongs
    // to this customer and nothing else, and one who also works for another
    // landlord and must be left entirely alone.
    dualMemberUserId = await addMember(org.organisationId, 'Dual Member', ['property_manager']);
    const elsewhere = await createOrganisation('Elsewhere Props');
    await ownerSql()`
      insert into memberships (organisation_id, auth_user_id, status)
      values (${elsewhere.organisationId}::uuid, ${dualMemberUserId}::uuid, 'active')
    `;

    // A document, because rows are not the whole of a customer's data: the
    // bytes are in a bucket and this row is the only record of where.
    await ownerSql()`
      insert into documents (
        organisation_id, classification, title, storage_bucket, storage_key,
        content_type, byte_size, visibility, scan_status, quarantined,
        retention_class, version
      ) values (
        ${org.organisationId}::uuid, 'lease', 'Signed lease agreement',
        'documents', ${`org/${org.organisationId}/lease-agreement.pdf`},
        'application/pdf', 12345, 'internal', 'clean', false, 'lease', 1
      )
    `;

    // Spike's own invoice to them.
    await ownerSql()`
      insert into subscription_invoices (
        organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
        currency_code, plan_key, plan_name, included_units, billable_units, units_over,
        subtotal_minor, vat_rate_bp, vat_minor, total_minor, status, created_by,
        recipient_name
      ) values (
        ${org.organisationId}::uuid, ${'SPK-TEST-' + org.slug.slice(-6)},
        date_trunc('month', current_date)::date,
        (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
        current_date, current_date + 14, 'ZAR', 'portfolio', 'Portfolio',
        50, 1, 0, 100000, 1500, 15000, 115000, 'issued', ${admin}::uuid,
        'Departing Props (Pty) Ltd'
      )
    `;
  });

  afterAll(async () => { await closeOwner(); });

  it('closes with a reason and a retention date from the platform default', async () => {
    // Support cannot close an account: `platform.customers.status` is the
    // administrators' permission, the same one that suspends.
    await expect(asPlatformOperator(support, (tx) =>
      closeCustomer(tx, support, {
        organisationId: org.organisationId, reason: 'Trying to close an account',
      }))).rejects.toThrow(/platform role/i);

    const { retainUntil } = await asPlatformOperator(admin, (tx) =>
      closeCustomer(tx, admin, {
        organisationId: org.organisationId,
        reason: 'The customer sold the portfolio and asked to close on ticket SPK-7100.',
      }));

    // Five years by default, which is Spike's own setting rather than a law
    // this test is in a position to assert.
    const months = Math.round(
      (new Date(retainUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44),
    );
    expect(months).toBeGreaterThanOrEqual(59);
    expect(months).toBeLessThanOrEqual(61);

    const closure = await asPlatformOperator(support, (tx) =>
      customerClosure(tx, org.organisationId));
    expect(closure?.reason).toContain('SPK-7100');
    expect(closure?.closedByName).toBe('Spike Closer');
    expect(closure?.destroyedAt).toBeNull();
    expect(closure?.destructionDue).toBe(false);

    const [status] = await ownerSql()<{ status: string }[]>`
      select status::text from organisations where id = ${org.organisationId}::uuid
    `;
    expect(status?.status).toBe('closed');
  });

  it('is the only way in: setAccountStatus cannot reach closed', async () => {
    const other = await createOrganisation('Still Trading');
    await expect(asPlatformOperator(admin, (tx) =>
      setAccountStatus(tx, admin, {
        organisationId: other.organisationId, status: 'closed',
        reason: 'Trying the old door',
      }))).rejects.toThrow(/closure form/i);
  });

  it('the customer can read their own closure, and see the date', async () => {
    const closure = await as(org.adminUserId, (tx) =>
      customerClosure(tx, org.organisationId));
    expect(closure?.retainUntil).toBeTruthy();
    expect(closure?.reason).toContain('SPK-7100');
  });

  it('refuses destruction before the retention date, and to the wrong hands', async () => {
    // Not yet due.
    await expect(asPlatformOperator(admin, (tx) =>
      destroyCustomerData(tx, admin, {
        organisationId: org.organisationId, confirmSlug: org.slug,
        reason: 'Customer asked for removal on SPK-7101',
      }))).rejects.toThrow(/retained until/i);

    // Support cannot bring the date forward either.
    await expect(asPlatformOperator(support, (tx) =>
      setRetention(tx, support, {
        organisationId: org.organisationId, retainUntil: '2020-01-01',
        reason: 'Trying to shorten it',
      }))).rejects.toThrow();

    await asPlatformOperator(admin, (tx) => setRetention(tx, admin, {
      organisationId: org.organisationId, retainUntil: '2020-01-01',
      reason: 'The customer asked for removal now, in writing, on SPK-7101.',
    }));

    // Due now — but support still cannot destroy.
    await expect(asPlatformOperator(support, (tx) =>
      destroyCustomerData(tx, support, {
        organisationId: org.organisationId, confirmSlug: org.slug,
        reason: 'Customer asked for removal on SPK-7101',
      }))).rejects.toThrow();

    // And the identifier has to be typed correctly.
    await expect(asPlatformOperator(admin, (tx) =>
      destroyCustomerData(tx, admin, {
        organisationId: org.organisationId, confirmSlug: 'departing-props',
        reason: 'Customer asked for removal on SPK-7101',
      }))).rejects.toThrow(/type the account/i);
  });

  it('destroys the customer records and keeps Spike own records', async () => {
    const before = await rowsLeftFor(org.organisationId);
    expect(Object.keys(before).length).toBeGreaterThan(5);

    const { rowsDestroyed, objects } = await asPlatformOperator(admin, (tx) =>
      destroyCustomerData(tx, admin, {
        organisationId: org.organisationId, confirmSlug: org.slug,
        reason: 'The customer asked for removal in writing on ticket SPK-7101.',
      }));
    expect(rowsDestroyed).toBeGreaterThan(0);

    // The keys come back, read before the purge. Without them the file would
    // stay in the bucket with nothing left in the database to find it by.
    expect(objects.map((o) => o.key)).toContain(
      `org/${org.organisationId}/lease-agreement.pdf`,
    );
    destroyedObjects = objects.map((o) => o.key);

    // 3. Nothing anywhere, from the catalogue rather than from a list.
    expect(await rowsLeftFor(org.organisationId)).toEqual({});

    const sql = ownerSql();

    // 4. Spike's invoice to them, with the recipient frozen on it.
    const [invoice] = await sql<{ recipient_name: string }[]>`
      select recipient_name from subscription_invoices
      where organisation_id = ${org.organisationId}::uuid
    `;
    expect(invoice?.recipient_name).toBe('Departing Props (Pty) Ltd');

    // Spike's conduct survives; the customer's own trail does not.
    const [audit] = await sql<{ platform: string; customer: string }[]>`
      select
        count(*) filter (where action like 'platform.%')::text as platform,
        count(*) filter (where action not like 'platform.%' and action <> 'customer.exported')::text as customer
      from audit_events where organisation_id = ${org.organisationId}::uuid
    `;
    expect(Number(audit?.platform)).toBeGreaterThan(0);
    expect(Number(audit?.customer)).toBe(0);

    // The destruction itself is in the trail, with who and why.
    const [recorded] = await sql<{ reason: string }[]>`
      select reason from audit_events
      where organisation_id = ${org.organisationId}::uuid
        and action = 'platform.account.data_destroyed'
    `;
    expect(recorded?.reason).toContain('SPK-7101');

    // The customer's own consent to support access survives, pointing at the
    // administrator who gave it.
    const [session] = await sql<{ authorised_by: string }[]>`
      select authorised_by::text from support_sessions
      where organisation_id = ${org.organisationId}::uuid
    `;
    expect(session?.authorised_by).toBe(org.adminUserId);

    // The organisation stays as a tombstone, and the closure carries the count.
    const closure = await asPlatformOperator(admin, (tx) =>
      customerClosure(tx, org.organisationId));
    expect(closure?.destroyedAt).toBeTruthy();
    expect(closure?.destroyedByName).toBe('Spike Closer');
    expect(closure?.rowsDestroyed).toBe(rowsDestroyed);
  });

  it('writes down the files, including any the bucket would not give up', async () => {
    // What the caller does after the transaction commits: one removed, one
    // that would not go.
    const [removedKey, ...rest] = destroyedObjects;
    expect(removedKey).toBeTruthy();
    await asPlatformOperator(admin, (tx) => recordDestroyedObjects(tx, admin, {
      organisationId: org.organisationId,
      removed: 1,
      left: ['org/stubborn/file-that-would-not-delete.pdf', ...rest.slice(0, 0)],
    }));

    const closure = await asPlatformOperator(admin, (tx) =>
      customerClosure(tx, org.organisationId));
    expect(closure?.objectsRemoved).toBe(1);
    // Kept so somebody can finish the job: a file left behind with its key
    // written down is a job, and one with its key deleted is personal
    // information nobody can find again.
    expect(closure?.objectsLeft).toEqual(['org/stubborn/file-that-would-not-delete.pdf']);

    // And it is in Spike's trail rather than only in a log nobody reads.
    const [noted] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from audit_events
      where organisation_id = ${org.organisationId}::uuid
        and action = 'platform.account.objects_left'
    `;
    expect(Number(noted?.count)).toBe(1);
  });

  it('anonymises the people left with nothing to belong to', async () => {
    const sql = ownerSql();

    for (const [who, userId] of [['the administrator', org.adminUserId]] as const) {
      const [user] = await sql<{ email: string; password_hash: string }[]>`
        select email, password_hash from auth.users where id = ${userId}::uuid
      `;
      expect(user?.email, who).toMatch(/^destroyed-.*@invalid$/);
      // Not a hash verifyPassword will accept, rather than an absent one
      // somebody could then set.
      expect(user?.password_hash, who).toMatch(/^destroyed\$/);

      const [profile] = await sql<{ full_name: string; phone: string | null }[]>`
        select full_name, phone from user_profiles where auth_user_id = ${userId}::uuid
      `;
      expect(profile?.full_name, who).toBe('Removed');
      expect(profile?.phone, who).toBeNull();

      const [factors] = await sql<{ count: string }[]>`
        select count(*)::text from auth_mfa_factors where auth_user_id = ${userId}::uuid
      `;
      expect(Number(factors?.count), who).toBe(0);
    }

    // Somebody who also works for another landlord keeps their name, their
    // login and their second factor: this account closing is not an event in
    // their life anywhere else.
    const [dual] = await sql<{ full_name: string; email: string }[]>`
      select p.full_name, u.email from user_profiles p
      join auth.users u on u.id = p.auth_user_id
      where p.auth_user_id = ${dualMemberUserId}::uuid
    `;
    expect(dual?.full_name).toBe('Dual Member');
    expect(dual?.email).not.toMatch(/^destroyed-/);

    // And Spike's own operators are untouched.
    const [operator] = await sql<{ full_name: string }[]>`
      select full_name from user_profiles where auth_user_id = ${admin}::uuid
    `;
    expect(operator?.full_name).toBe('Spike Closer');
  });

  /**
   * The production path, which the rest of this suite does not exercise.
   *
   * `asPlatformOperator` lifts row-level filtering, and the web application
   * does not: a Server Action runs a destruction under the operator's own
   * context. `documents` is keyed on membership and an operator is a member of
   * nothing, so the first version of this read the storage keys in TypeScript,
   * got none in production, and would have left every file in the bucket with
   * the only record of where it was deleted. The keys now come from the
   * security-definer function, and this is the test that would have said so.
   */
  it('hands back the file keys under the context the application actually uses', async () => {
    const leaving = await createOrganisation('Also Leaving', { planKey: 'starter' });
    const key = `org/${leaving.organisationId}/identity-document.pdf`;
    await ownerSql()`
      insert into documents (
        organisation_id, classification, title, storage_bucket, storage_key,
        content_type, byte_size, visibility, scan_status, quarantined,
        retention_class, version
      ) values (
        ${leaving.organisationId}::uuid, 'identity', 'Identity document',
        'documents', ${key}, 'application/pdf', 2048, 'internal', 'clean', false,
        'identity', 1
      )
    `;
    await asPlatformOperator(admin, (tx) => closeCustomer(tx, admin, {
      organisationId: leaving.organisationId, retainMonths: 0,
      reason: 'The customer asked for immediate removal on SPK-7103.',
    }));

    // No privilege lift: the operator's own context, as a Server Action has.
    const { objects } = await as(admin, (tx) => destroyCustomerData(tx, admin, {
      organisationId: leaving.organisationId, confirmSlug: leaving.slug,
      reason: 'The customer asked for immediate removal on SPK-7103.',
    }));

    expect(objects.map((o) => o.key)).toEqual([key]);
    expect(await rowsLeftFor(leaving.organisationId)).toEqual({});
  });

  it('will not destroy twice, or reopen onto an empty console', async () => {
    await expect(asPlatformOperator(admin, (tx) =>
      destroyCustomerData(tx, admin, {
        organisationId: org.organisationId, confirmSlug: org.slug,
        reason: 'Trying again by accident',
      }))).rejects.toThrow(/were destroyed on/i);

    await expect(asPlatformOperator(admin, (tx) =>
      setAccountStatus(tx, admin, {
        organisationId: org.organisationId, status: 'active',
        reason: 'The customer changed their mind',
      }))).rejects.toThrow(/empty console/i);

    // It is still listed, which is the point of a tombstone.
    const closures = await asPlatformOperator(admin, (tx) => listClosures(tx, admin));
    const mine = closures.find((c) => c.organisationId === org.organisationId);
    expect(mine?.destroyedAt).toBeTruthy();
    expect(mine?.name).toBe('Departing Props');
  });
});
