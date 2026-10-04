/**
 * Adversarial review of the isolation, permission and worker paths.
 *
 * Written looking for holes rather than for confirmation. Each test names the
 * specific way it tries to get through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withActor } from '@propertyos/db';
import {
  activateLease, confirmReceipt, createResident, createStandaloneHouse,
  draftLease, parseMajorToMinor, postCharge, previewBillingRun,
} from '@propertyos/domain';
import {
  addMember, as, asSingleFactor, closeOwner, createAuthUser, createOrganisation,
  grantPortalAccess, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Adversarial: isolation', () => {
  let orgA: OrganisationFixture;
  let orgB: OrganisationFixture;
  let leaseA: string;
  let unitB: string;
  let residentA: string;

  beforeAll(async () => {
    orgA = await createOrganisation('Adversarial Org A');
    orgB = await createOrganisation('Adversarial Org B');

    const resident = await as(orgA.adminUserId, (tx) =>
      createResident(tx, orgA.organisationId, orgA.adminUserId, { firstName: 'A', lastName: 'Resident' }),
    );
    residentA = resident.residentId;
    const houseA = await as(orgA.adminUserId, (tx) =>
      createStandaloneHouse(tx, orgA.organisationId, orgA.adminUserId, {
        name: 'A House', code: 'ADVA', propertyType: 'house',
        addressLine1: '1 A Road', city: 'Cape Town',
      }),
    );
    const lease = await as(orgA.adminUserId, (tx) =>
      draftLease(tx, orgA.organisationId, orgA.adminUserId, {
        unitId: houseA.unitId, startDate: '2026-01-01', rentMinor: R('5000'),
        parties: [{ residentId: residentA, role: 'primary_resident' }],
      }),
    );
    leaseA = lease.leaseId;
    await as(orgA.adminUserId, (tx) =>
      activateLease(tx, orgA.organisationId, orgA.adminUserId, {
        leaseId: leaseA, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );

    const houseB = await as(orgB.adminUserId, (tx) =>
      createStandaloneHouse(tx, orgB.organisationId, orgB.adminUserId, {
        name: 'B House', code: 'ADVB', propertyType: 'house',
        addressLine1: '1 B Road', city: 'Durban',
      }),
    );
    unitB = houseB.unitId;
  });

  afterAll(async () => { await closeOwner(); });

  it('cannot draft a lease in my organisation against another organisation unit', async () => {
    // The unit id is valid — it just belongs to someone else.
    await expect(
      as(orgA.adminUserId, (tx) =>
        draftLease(tx, orgA.organisationId, orgA.adminUserId, {
          unitId: unitB, startDate: '2026-01-01', rentMinor: R('5000'),
          parties: [{ residentId: residentA, role: 'primary_resident' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot add a foreign resident as a party to my own lease', async () => {
    const foreign = await as(orgB.adminUserId, (tx) =>
      createResident(tx, orgB.organisationId, orgB.adminUserId, { firstName: 'B', lastName: 'Resident' }),
    );
    const houseA2 = await as(orgA.adminUserId, (tx) =>
      createStandaloneHouse(tx, orgA.organisationId, orgA.adminUserId, {
        name: 'A House 2', code: 'ADVA2', propertyType: 'house',
        addressLine1: '2 A Road', city: 'Cape Town',
      }),
    );
    await expect(
      as(orgA.adminUserId, (tx) =>
        draftLease(tx, orgA.organisationId, orgA.adminUserId, {
          unitId: houseA2.unitId, startDate: '2026-01-01', rentMinor: R('5000'),
          parties: [{ residentId: foreign.residentId, role: 'primary_resident' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('cannot confirm a receipt into my book against another organisation lease', async () => {
    await expect(
      as(orgB.adminUserId, (tx) =>
        confirmReceipt(tx, orgB.organisationId, orgB.adminUserId, {
          leaseId: leaseA, amountMinor: R('1000'), receivedOn: '2026-01-05',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a billing preview never reaches across organisations', async () => {
    await as(orgA.adminUserId, (tx) =>
      postCharge(tx, orgA.organisationId, orgA.adminUserId, {
        leaseId: leaseA, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'Rent', amountMinor: R('5000'), dueDate: '2026-01-01' }],
      }),
    );
    const preview = await as(orgB.adminUserId, (tx) =>
      previewBillingRun(tx, orgB.organisationId, { periodStart: '2026-01-01' }),
    );
    expect(preview.lines.every((l) => l.leaseId !== leaseA)).toBe(true);
    expect(preview.totalMinor).toBe(0n);
  });

  it('a resident cannot read the organisation audit trail', async () => {
    const residentUser = await grantPortalAccess(orgA.organisationId, leaseA, residentA, 'Audit Prober');
    await as(residentUser, async (tx) => {
      expect(await tx`select id from audit_events`).toHaveLength(0);
      expect(await tx`select id from outbox_events`).toHaveLength(0);
      expect(await tx`select id from journals`).toHaveLength(0);
      expect(await tx`select id from journal_lines`).toHaveLength(0);
      expect(await tx`select id from bank_accounts`).toHaveLength(0);
      expect(await tx`select id from memberships`).toHaveLength(0);
    });
  });

  it('a resident cannot write to their own lease or charges', async () => {
    const residentUser = await grantPortalAccess(orgA.organisationId, leaseA, residentA, 'Write Prober');
    const [before] = await ownerSql()<{ rent_minor: string }[]>`
      select rent_minor::text from leases where id = ${leaseA}
    `;
    await as(residentUser, (tx) => tx`update leases set rent_minor = 1 where id = ${leaseA}::uuid`);
    const [after] = await ownerSql()<{ rent_minor: string }[]>`
      select rent_minor::text from leases where id = ${leaseA}
    `;
    // RLS filters the UPDATE to zero rows rather than raising; what matters is
    // that nothing changed.
    expect(after!.rent_minor).toBe(before!.rent_minor);
  });

  it('a revoked membership loses access on the very next request', async () => {
    const member = await addMember(orgA.organisationId, 'Soon Revoked', ['property_manager']);
    await as(member, async (tx) => {
      expect((await tx`select id from properties`).length).toBeGreaterThan(0);
    });
    await ownerSql()`
      update memberships set status = 'revoked'
      where organisation_id = ${orgA.organisationId} and auth_user_id = ${member}
    `;
    await as(member, async (tx) => {
      expect(await tx`select id from properties`).toHaveLength(0);
    });
  });

  it('a suspended membership is treated as no membership', async () => {
    const member = await addMember(orgA.organisationId, 'Soon Suspended', ['property_manager']);
    await ownerSql()`
      update memberships set status = 'suspended'
      where organisation_id = ${orgA.organisationId} and auth_user_id = ${member}
    `;
    await as(member, async (tx) => {
      expect(await tx`select id from properties`).toHaveLength(0);
      const [row] = await tx<{ ok: boolean }[]>`
        select app.is_org_member(${orgA.organisationId}::uuid) as ok
      `;
      expect(row!.ok).toBe(false);
    });
  });

  it('an empty or malformed claims string resolves to no user, not to everyone', async () => {
    const { sql } = await import('@propertyos/db');
    await sql().begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', '', true)`;
      const [row] = await tx<{ uid: string | null }[]>`select auth.uid()::text as uid`;
      expect(row!.uid).toBeNull();
      expect(await tx`select id from leases`).toHaveLength(0);
      expect(await tx`select id from organisations`).toHaveLength(0);
    });
  });

  it('a membership in organisation B grants nothing in organisation A', async () => {
    // The same human, a member of both, must not blend the two.
    const shared = await addMember(orgA.organisationId, 'Dual Member', ['property_manager']);
    await ownerSql()`
      insert into memberships (organisation_id, auth_user_id, status)
      values (${orgB.organisationId}, ${shared}, 'active')
    `;
    await as(shared, async (tx) => {
      // No property assignment in B, so no properties there, but A still works.
      const all = await tx<{ organisation_id: string }[]>`select organisation_id from properties`;
      expect(all.every((p) => p.organisation_id === orgA.organisationId)).toBe(true);
    });
  });
});

describe('Adversarial: permission boundaries', () => {
  let org: OrganisationFixture;

  beforeAll(async () => { org = await createOrganisation('Adversarial Permission Co'); });
  afterAll(async () => { await closeOwner(); });

  it('a member with no roles at all holds no permissions', async () => {
    const roleless = await addMember(org.organisationId, 'No Roles', []);
    await as(roleless, async (tx) => {
      for (const permission of ['billing.post', 'payment.allocate', 'lease.create', 'report.read']) {
        const [row] = await tx<{ ok: boolean }[]>`
          select app.has_permission(${org.organisationId}::uuid, ${permission}) as ok
        `;
        expect(row!.ok).toBe(false);
      }
    });
  });

  it('an unknown permission key grants nothing rather than erroring open', async () => {
    await as(org.adminUserId, async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.has_permission(${org.organisationId}::uuid, 'nonexistent.permission') as ok
      `;
      expect(row!.ok).toBe(false);
    });
  });

  it('a permission check for another organisation returns false, not an error', async () => {
    const other = await createOrganisation('Permission Neighbour');
    await as(org.adminUserId, async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.has_permission(${other.organisationId}::uuid, 'billing.post') as ok
      `;
      expect(row!.ok).toBe(false);
    });
  });

  it('an owner viewer cannot post, allocate or manage anything', async () => {
    const owner = await addMember(org.organisationId, 'Owner Viewer', ['owner_viewer']);
    await as(owner, async (tx) => {
      for (const permission of [
        'billing.post', 'payment.allocate', 'payment.record', 'lease.create',
        'resident.manage', 'deposit.refund.approve', 'membership.manage',
      ]) {
        const [row] = await tx<{ ok: boolean }[]>`
          select app.has_permission(${org.organisationId}::uuid, ${permission}) as ok
        `;
        expect(row!.ok).toBe(false);
      }
    });
  });

  it('a finance preparer cannot approve their own deposit refund', async () => {
    const preparer = await addMember(org.organisationId, 'Preparer Only', ['finance_preparer']);
    await as(preparer, async (tx) => {
      const [row] = await tx<{ record: boolean; approve: boolean }[]>`
        select app.has_permission(${org.organisationId}::uuid, 'deposit.record') as record,
               app.has_permission(${org.organisationId}::uuid, 'deposit.refund.approve') as approve
      `;
      // Can prepare, cannot approve. The segregation the blueprint requires.
      expect(row!.record).toBe(true);
      expect(row!.approve).toBe(false);
    });
  });

  it('single-factor sessions lose MFA-gated permissions but keep the rest', async () => {
    const approver = await addMember(org.organisationId, 'Dual Role', ['finance_preparer', 'finance_approver']);
    const weak = await asSingleFactor(approver, async (tx) => {
      const [row] = await tx<{ post: boolean; record: boolean }[]>`
        select app.has_permission(${org.organisationId}::uuid, 'billing.post') as post,
               app.has_permission(${org.organisationId}::uuid, 'payment.record') as record
      `;
      return row!;
    });
    // billing.post comes only through the MFA-gated approver role, so it is
    // withheld. payment.record also comes through the preparer role, which is
    // not gated, so it survives.
    expect(weak.post).toBe(false);
    expect(weak.record).toBe(true);
  });
});

describe('Adversarial: worker and job paths', () => {
  let org: OrganisationFixture;

  beforeAll(async () => { org = await createOrganisation('Adversarial Worker Co'); });
  afterAll(async () => { await closeOwner(); });

  it('a job payload cannot widen the worker organisation scope', async () => {
    const other = await createOrganisation('Worker Neighbour');
    const sql = ownerSql();
    // A job claiming to belong to one organisation while naming another in its
    // payload. The worker derives scope from the ROW, never from the payload.
    const [job] = await sql<{ id: string; organisation_id: string }[]>`
      insert into jobs (organisation_id, job_type, payload)
      values (${org.organisationId}, 'event:charge.posted',
              ${sql.json({ organisationId: other.organisationId, injected: true } as never)})
      returning id, organisation_id
    `;
    const { claimJob } = await import('../../apps/worker/src/queue.js');
    const claimed = await claimJob(sql as never, 'adversarial-worker');
    expect(claimed!.id).toBe(job!.id);
    // The scope the worker acts on is the column, not the payload field.
    expect(claimed!.organisationId).toBe(org.organisationId);
    expect(claimed!.organisationId).not.toBe(other.organisationId);
  });

  it('publishing the outbox twice produces one job, not two', async () => {
    const sql = ownerSql();
    await sql`
      insert into outbox_events (organisation_id, event_type, resource_type, payload)
      values (${org.organisationId}, 'charge.posted', 'charge_document', '{}'::jsonb)
    `;
    const { publishOutbox } = await import('../../apps/worker/src/outbox.js');
    const first = await publishOutbox(sql as never);
    expect(first).toBeGreaterThanOrEqual(1);

    // Simulate a redelivery: unpublish and publish again.
    const [event] = await sql<{ id: string }[]>`
      select id from outbox_events where organisation_id = ${org.organisationId} order by id desc limit 1
    `;
    await sql`update outbox_events set published_at = null where id = ${event!.id}`;
    await publishOutbox(sql as never);

    const [jobs] = await sql<{ c: string }[]>`
      select count(*)::text as c from jobs where idempotency_key = ${`outbox-${event!.id}`}
    `;
    expect(jobs!.c).toBe('1');
  });

  it('a dead job stays dead rather than being retried forever', async () => {
    const sql = ownerSql();
    const [job] = await sql<{ id: string }[]>`
      insert into jobs (organisation_id, job_type, payload, status, attempts, max_attempts)
      values (${org.organisationId}, 'event:dead', '{}'::jsonb, 'dead', 5, 5)
      returning id
    `;
    const { claimJob } = await import('../../apps/worker/src/queue.js');
    // Drain anything else that is claimable so the assertion is about this job.
    let claimed = await claimJob(sql as never, 'drain');
    while (claimed) {
      if (claimed.id === job!.id) throw new Error('a dead job was claimed');
      claimed = await claimJob(sql as never, 'drain');
    }
    const [row] = await sql<{ status: string }[]>`select status from jobs where id = ${job!.id}`;
    expect(row!.status).toBe('dead');
  });
});
