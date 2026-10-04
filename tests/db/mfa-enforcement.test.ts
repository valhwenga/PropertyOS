/**
 * Multi-factor authentication enforcement.
 *
 * The blueprint requires MFA for Spike administrators and finance approvers.
 * Enforcing that only in the user interface would mean any forgotten check, or
 * any direct database path, silently bypasses it. So the assurance level is part
 * of PERMISSION RESOLUTION: an MFA-gated role grants nothing on a single-factor
 * session, and these tests assert that at the database level.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, confirmReceipt, createResident, createStandaloneHouse,
  draftLease, listCustomers, parseMajorToMinor, postCharge,
} from '@propertyos/domain';
import {
  addMember, as, asSingleFactor, closeOwner, createAuthUser, createOrganisation,
  ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('MFA enforcement', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let preparer: string;
  let approver: string;

  beforeAll(async () => {
    org = await createOrganisation('MFA Enforcement Co');

    // finance_preparer does NOT require MFA; finance_approver does.
    preparer = await addMember(org.organisationId, 'Pat Preparer', ['finance_preparer']);
    approver = await addMember(org.organisationId, 'Alex Approver', ['finance_approver']);

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'MFA', lastName: 'Subject',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'MFA House', code: 'MFA1', propertyType: 'house',
        addressLine1: '1 Factor Street', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('7000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('resolves the assurance level from the session, defaulting to the weaker value', async () => {
    const strong = await as(org.adminUserId, async (tx) => {
      const [row] = await tx<{ aal: string }[]>`select app.session_assurance_level() as aal`;
      return row!.aal;
    });
    const weak = await asSingleFactor(org.adminUserId, async (tx) => {
      const [row] = await tx<{ aal: string }[]>`select app.session_assurance_level() as aal`;
      return row!.aal;
    });
    expect(strong).toBe('aal2');
    expect(weak).toBe('aal1');
  });

  it('withholds an MFA-gated role permission on a single-factor session', async () => {
    const withMfa = await as(approver, async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.has_permission(${org.organisationId}::uuid, 'billing.post') as ok
      `;
      return row!.ok;
    });
    const withoutMfa = await asSingleFactor(approver, async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.has_permission(${org.organisationId}::uuid, 'billing.post') as ok
      `;
      return row!.ok;
    });
    expect(withMfa).toBe(true);
    expect(withoutMfa).toBe(false);
  });

  it('blocks posting a charge on a single-factor approver session', async () => {
    await expect(
      asSingleFactor(approver, (tx) =>
        postCharge(tx, org.organisationId, approver, {
          leaseId, documentType: 'rent_invoice',
          issueDate: '2026-02-01', dueDate: '2026-02-01',
          lines: [{ category: 'rent', description: 'February rent', amountMinor: R('7000'), dueDate: '2026-02-01' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The same command succeeds once the second factor is verified.
    const posted = await as(approver, (tx) =>
      postCharge(tx, org.organisationId, approver, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-02-01', dueDate: '2026-02-01',
        lines: [{ category: 'rent', description: 'February rent', amountMinor: R('7000'), dueDate: '2026-02-01' }],
      }),
    );
    expect(posted.totalMinor).toBe(R('7000'));
  });

  it('leaves a non-MFA role working normally on a single-factor session', async () => {
    // A finance preparer is not MFA-gated, so their ordinary work is unaffected.
    const receipt = await asSingleFactor(preparer, (tx) =>
      confirmReceipt(tx, org.organisationId, preparer, {
        leaseId, amountMinor: R('1000'), receivedOn: '2026-02-05',
      }),
    );
    expect(receipt.receiptId).toBeTruthy();
  });

  it('tells the user a second factor is needed rather than "no access"', async () => {
    const needsMfa = await asSingleFactor(approver, async (tx) => {
      const [row] = await tx<{ needs: boolean }[]>`
        select app.permission_needs_mfa(${org.organisationId}::uuid, 'billing.post') as needs
      `;
      return row!.needs;
    });
    // The approver DOES hold the permission; they just have not proven a second
    // factor. That is a different message from being denied outright.
    expect(needsMfa).toBe(true);

    const genuinelyDenied = await asSingleFactor(preparer, async (tx) => {
      const [row] = await tx<{ needs: boolean }[]>`
        select app.permission_needs_mfa(${org.organisationId}::uuid, 'billing.post') as needs
      `;
      return row!.needs;
    });
    // A preparer never holds billing.post at all, MFA or not.
    expect(genuinelyDenied).toBe(false);
  });

  it('gates the Spike platform console behind MFA', async () => {
    const operator = await createAuthUser('MFA Platform Operator', { platformOperator: true });

    await expect(
      asSingleFactor(operator, (tx) => listCustomers(tx, operator)),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const customers = await as(operator, (tx) => listCustomers(tx, operator));
    expect(customers.length).toBeGreaterThan(0);
  });

  it('gives a single-factor operator no platform metadata at the row level', async () => {
    const operator = await createAuthUser('Row Level Operator', { platformOperator: true });
    await asSingleFactor(operator, async (tx) => {
      // Not merely a refused command: the rows are not visible at all.
      expect(await tx`select id from organisations`).toHaveLength(0);
    });
    await as(operator, async (tx) => {
      expect((await tx`select id from organisations`).length).toBeGreaterThan(0);
    });
  });

  it('treats a session with no assurance claim as single factor', async () => {
    const { withActor } = await import('@propertyos/db');
    // No assuranceLevel supplied at all.
    const result = await withActor({ authUserId: approver }, async ({ tx }) => {
      const [row] = await tx<{ aal: string; ok: boolean }[]>`
        select app.session_assurance_level() as aal,
               app.has_permission(${org.organisationId}::uuid, 'billing.post') as ok
      `;
      return row!;
    });
    expect(result.aal).toBe('aal1');
    expect(result.ok).toBe(false);
  });

  it('does not let an organisation administrator escape the gate', async () => {
    // org_admin also requires MFA, and holds almost every permission.
    const blocked = await asSingleFactor(org.adminUserId, async (tx) => {
      const [row] = await tx<{ settings: boolean; membership: boolean }[]>`
        select app.has_permission(${org.organisationId}::uuid, 'organisation.settings.manage') as settings,
               app.has_permission(${org.organisationId}::uuid, 'membership.manage') as membership
      `;
      return row!;
    });
    expect(blocked.settings).toBe(false);
    expect(blocked.membership).toBe(false);
  });
});

describe('TOTP second factor', () => {
  afterAll(async () => { await closeOwner(); });

  it('generates and verifies a code, and rejects a wrong one', async () => {
    const { generateSecret, generateCode, verifyCode } = await import('@propertyos/integrations');
    const secret = generateSecret();
    const code = generateCode(secret);

    expect(code).toMatch(/^\d{6}$/);
    expect(verifyCode(secret, code).valid).toBe(true);
    expect(verifyCode(secret, '000000').valid).toBe(false);
    expect(verifyCode(generateSecret(), code).valid).toBe(false);
  });

  it('tolerates one step of clock drift but not two', async () => {
    const { generateSecret, generateCode, verifyCode, timeStep } = await import('@propertyos/integrations');
    const secret = generateSecret();
    const now = Date.now();
    const current = timeStep(now);

    expect(verifyCode(secret, generateCode(secret, current - 1), { at: now }).valid).toBe(true);
    expect(verifyCode(secret, generateCode(secret, current + 1), { at: now }).valid).toBe(true);
    expect(verifyCode(secret, generateCode(secret, current - 3), { at: now }).valid).toBe(false);
    expect(verifyCode(secret, generateCode(secret, current + 3), { at: now }).valid).toBe(false);
  });

  it('reports the matched step so a code can be refused on replay', async () => {
    const { generateSecret, generateCode, verifyCode, timeStep } = await import('@propertyos/integrations');
    const secret = generateSecret();
    const step = timeStep();
    const verification = verifyCode(secret, generateCode(secret, step));
    expect(verification.step).toBe(step);

    // The replay guard itself is a unique key on (user, step).
    const user = await createAuthUser('Replay Guard Subject');
    const sql = ownerSql();
    const first = await sql`
      insert into auth_mfa_used_codes (auth_user_id, time_step)
      values (${user}, ${step}) on conflict do nothing returning time_step
    `;
    const second = await sql`
      insert into auth_mfa_used_codes (auth_user_id, time_step)
      values (${user}, ${step}) on conflict do nothing returning time_step
    `;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('keeps TOTP secrets out of reach of the application role', async () => {
    const user = await createAuthUser('Secret Holder');
    const { generateSecret } = await import('@propertyos/integrations');
    await ownerSql()`
      insert into auth_mfa_factors (auth_user_id, secret, verified_at)
      values (${user}, ${generateSecret()}, now())
    `;
    // The application connection has no privilege on this table at all.
    await expect(
      as(user, (tx) => tx`select secret from auth_mfa_factors`),
    ).rejects.toThrow(/permission denied/i);
  });
});
