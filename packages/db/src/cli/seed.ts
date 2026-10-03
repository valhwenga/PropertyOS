/**
 * Development seed data.
 *
 * Everything created here is CLEARLY SYNTHETIC: names are invented, emails use
 * the reserved `.invalid` TLD, and every organisation name is prefixed "[DEMO]".
 *
 * The script refuses to run when NODE_ENV is production. Production totals must
 * come from real records; demo figures must never stand in for them.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  activateLease, allocateReceipt, confirmReceipt, createOrganisationWithOwner,
  createResident, createStandaloneHouse, createProperty, createUnit, draftLease,
  parseMajorToMinor, postCharge, submitPaymentEvidence, suggestAllocation,
} from '../../../domain/src/index';
import type { Sql } from '../client';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;
const R = (v: string) => parseMajorToMinor(v, 'ZAR');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo data into a production environment.');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const sql = postgres(url, { max: 1, onnotice: () => {} }) as Sql;
  const password = process.env.SEED_PASSWORD ?? 'DemoPassword123!';
  const hash = await hashPassword(password);

  try {
    const createUser = async (name: string, email: string, operator = false) => {
      const id = randomUUID();
      await sql`insert into auth.users (id, email, password_hash) values (${id}, ${email}, ${hash})`;
      await sql`
        insert into user_profiles (auth_user_id, full_name, email, is_platform_operator)
        values (${id}, ${name}, ${email}, ${operator})
      `;
      return id;
    };

    const adminId = await createUser('Nomsa Dlamini', 'admin@demo.invalid');
    const financeId = await createUser('Pieter van Wyk', 'finance@demo.invalid');
    const residentId1 = await createUser('Thandiwe Mokoena', 'thandiwe@demo.invalid');
    await createUser('Spike Support', 'support@demo.invalid', true);

    // Second organisation, so isolation is visible by simply signing in as its
    // admin and seeing nothing of the first.
    const otherAdminId = await createUser('Riaan Botha', 'other-admin@demo.invalid');

    const org = await sql.begin((tx) =>
      createOrganisationWithOwner(tx as unknown as Sql, {
        name: '[DEMO] Blue Crane Rentals', slug: 'demo-blue-crane',
        countryCode: 'ZA', currencyCode: 'ZAR', timeZone: 'Africa/Johannesburg',
        legalEntityName: '[DEMO] Blue Crane Rentals (Pty) Ltd', planKey: 'starter',
      }, adminId),
    ) as { organisationId: string; bookId: string };

    await sql.begin((tx) =>
      createOrganisationWithOwner(tx as unknown as Sql, {
        name: '[DEMO] Karoo Letting', slug: 'demo-karoo',
        countryCode: 'ZA', currencyCode: 'ZAR', timeZone: 'Africa/Johannesburg',
        legalEntityName: '[DEMO] Karoo Letting CC', planKey: 'starter',
      }, otherAdminId),
    );

    // A finance approver alongside the administrator.
    const [financeMembership] = await sql<{ id: string }[]>`
      insert into memberships (organisation_id, auth_user_id, status)
      values (${org.organisationId}, ${financeId}, 'active') returning id
    `;
    await sql`
      insert into membership_roles (membership_id, role_key)
      values (${financeMembership!.id}, 'finance_approver')
    `;
    await sql`
      insert into property_assignments (organisation_id, membership_id, scope_type)
      values (${org.organisationId}, ${financeMembership!.id}, 'organisation')
    `;

    const run = <T>(fn: (tx: Sql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId })}, true)`;
        return fn(tx as unknown as Sql);
      }) as Promise<T>;

    // A standalone house.
    const house = await run((tx) =>
      createStandaloneHouse(tx, org.organisationId, adminId, {
        name: '14 Protea Street', code: 'PROTEA14', propertyType: 'house',
        addressLine1: '14 Protea Street', suburb: 'Newlands', city: 'Cape Town',
        province: 'Western Cape', postalCode: '7700', countryCode: 'ZA',
      }),
    );

    // A small block with several units, to prove both shapes.
    const block = await run((tx) =>
      createProperty(tx, org.organisationId, adminId, {
        name: 'Aloe Court', code: 'ALOE', propertyType: 'apartment_block',
        addressLine1: '7 Aloe Avenue', suburb: 'Observatory', city: 'Cape Town',
        province: 'Western Cape', postalCode: '7925', countryCode: 'ZA',
      }),
    );
    for (const code of ['A1', 'A2', 'A3', 'B1']) {
      await run((tx) =>
        createUnit(tx, org.organisationId, adminId, {
          propertyId: block.propertyId, code, rentableType: 'apartment',
          bedrooms: 2, bathrooms: 1, advertisedRentMinor: R('6500'),
        }),
      );
    }

    const resident = await run((tx) =>
      createResident(tx, org.organisationId, adminId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
        email: 'thandiwe@demo.invalid', phone: '+27 82 555 0101',
      }),
    );
    const coLessee = await run((tx) =>
      createResident(tx, org.organisationId, adminId, {
        firstName: 'Sipho', lastName: 'Mokoena', email: 'sipho@demo.invalid',
      }),
    );

    // Joint lease: two parties, ONE rent receivable.
    const lease = await run((tx) =>
      draftLease(tx, org.organisationId, adminId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'), billingDay: 1, depositRequiredMinor: R('8000'),
        parties: [
          { residentId: resident.residentId, role: 'primary_resident', canViewFinancials: true },
          { residentId: coLessee.residentId, role: 'co_lessee', canViewFinancials: true },
        ],
      }),
    );
    await run((tx) =>
      activateLease(tx, org.organisationId, adminId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'DEMO DATA: signed contract not attached.',
      }),
    );

    // Portal access for the primary resident.
    await sql`
      insert into portal_links (
        organisation_id, resident_id, lease_id, auth_user_id, invited_email,
        status, accepted_at, expires_at
      ) values (
        ${org.organisationId}, ${resident.residentId}, ${lease.leaseId}, ${residentId1},
        'thandiwe@demo.invalid', 'active', now(), now() + interval '365 days'
      )
    `;

    // The blueprint's worked example, as real posted records.
    await run((tx) =>
      postCharge(tx, org.organisationId, adminId, {
        leaseId: lease.leaseId, documentType: 'opening_balance',
        issueDate: '2025-12-31', dueDate: '2025-12-31',
        lines: [{
          category: 'other',
          description: 'Opening arrears brought forward (DEMO, operator signed 2025-12-31)',
          amountMinor: R('1000'), dueDate: '2025-12-31',
        }],
      }),
    );
    await run((tx) =>
      postCharge(tx, org.organisationId, adminId, {
        leaseId: lease.leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        periodStart: '2026-01-01', periodEnd: '2026-01-31',
        lines: [{ category: 'rent', description: 'Monthly rent', amountMinor: R('8000'), dueDate: '2026-01-01' }],
      }),
    );
    await run((tx) =>
      postCharge(tx, org.organisationId, adminId, {
        leaseId: lease.leaseId, documentType: 'utility_invoice',
        issueDate: '2026-01-05', dueDate: '2026-01-07',
        lines: [{
          category: 'utility_water', description: 'Water — January reading, reviewed',
          amountMinor: R('350'), dueDate: '2026-01-07',
        }],
      }),
    );

    const receipt = await run((tx) =>
      confirmReceipt(tx, org.organisationId, adminId, {
        leaseId: lease.leaseId, amountMinor: R('7500'), receivedOn: '2026-01-07',
        method: 'eft', payerReference: 'MOKOENA PROTEA14',
      }),
    );
    const suggestion = await run((tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId: lease.leaseId, amountMinor: R('7500') }),
    );
    await run((tx) =>
      allocateReceipt(tx, org.organisationId, adminId, {
        receiptId: receipt.receiptId, allocations: suggestion.allocations, postingDate: '2026-01-07',
      }),
    );

    // Unverified evidence, to show it carries no accounting effect.
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: residentId1 })}, true)`;
      await submitPaymentEvidence(tx as unknown as Sql, org.organisationId, residentId1, {
        leaseId: lease.leaseId, claimedAmountMinor: R('1850'),
        claimedPaidAt: '2026-01-28', reference: 'DEMO screenshot of EFT',
      });
    });

    const [balance] = await sql<{ receivable_minor: string }[]>`
      select receivable_minor::text from lease_balances where lease_id = ${lease.leaseId}
    `;

    process.stdout.write(
      [
        '',
        'Demo data seeded. All records are synthetic and prefixed [DEMO].',
        '',
        `  Operator       admin@demo.invalid      / ${password}`,
        `  Finance        finance@demo.invalid    / ${password}`,
        `  Resident       thandiwe@demo.invalid   / ${password}`,
        `  Other customer other-admin@demo.invalid / ${password}   (sees none of the above)`,
        `  Spike support  support@demo.invalid    / ${password}   (needs an authorised session)`,
        '',
        `  Lease ${lease.reference} closing receivable: ${balance?.receivable_minor} minor units ` +
          '(expected 185000 = R1,850.00)',
        '',
      ].join('\n'),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
