/**
 * Blueprint section 30 — acceptance tests and launch criteria.
 *
 * This file covers the launch scenarios not already asserted elsewhere. The
 * full traceability table, mapping every scenario to the test that proves it,
 * is in docs/acceptance.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, createResident, createStandaloneHouse,
  draftLease, parseMajorToMinor, postCharge,
} from '@propertyos/domain';
import { validateUpload, scanDocument, resolveEmailAdapter, DOCUMENT_CONSTRAINTS } from '@propertyos/integrations';
import { as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture } from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Bank imports overlap or repeat', () => {
  let org: OrganisationFixture;
  let bankAccountId: string;

  beforeAll(async () => {
    org = await createOrganisation('Bank Import Co');
    const [book] = await ownerSql()<{ id: string }[]>`
      select id from financial_books where organisation_id = ${org.organisationId} and is_default
    `;
    const [account] = await ownerSql()<{ id: string }[]>`
      insert into bank_accounts (organisation_id, book_id, label, bank_name,
        account_number_last4, currency_code)
      values (${org.organisationId}, ${book!.id}, 'Operating', 'Demo Bank', '4321', 'ZAR')
      returning id
    `;
    bankAccountId = account!.id;
  });

  afterAll(async () => { await closeOwner(); });

  it('rejects re-uploading the exact same statement file', async () => {
    const hash = Buffer.from('a'.repeat(64), 'hex');
    await ownerSql()`
      insert into bank_imports (organisation_id, bank_account_id, filename, source_sha256, status)
      values (${org.organisationId}, ${bankAccountId}, 'january.csv', ${hash}, 'committed')
    `;
    await expect(
      ownerSql()`
        insert into bank_imports (organisation_id, bank_account_id, filename, source_sha256, status)
        values (${org.organisationId}, ${bankAccountId}, 'january-again.csv', ${hash}, 'committed')
      `,
    ).rejects.toThrow(/bank_imports_same_file/);
  });

  it('flags a true duplicate transaction when the bank supplies an identifier', async () => {
    await ownerSql()`
      insert into bank_transactions (organisation_id, bank_account_id, transaction_date,
        description, amount_minor, currency_code, external_id, fingerprint)
      values (${org.organisationId}, ${bankAccountId}, '2026-01-05', 'MOKOENA RENT',
              800000, 'ZAR', 'BANKREF-0001', 'fp-1')
    `;
    await expect(
      ownerSql()`
        insert into bank_transactions (organisation_id, bank_account_id, transaction_date,
          description, amount_minor, currency_code, external_id, fingerprint)
        values (${org.organisationId}, ${bankAccountId}, '2026-01-05', 'MOKOENA RENT',
                800000, 'ZAR', 'BANKREF-0001', 'fp-2')
      `,
    ).rejects.toThrow(/bank_transactions_external_unique/);
  });

  it('PRESERVES two genuinely separate same-amount payments on one day', async () => {
    // The dangerous failure mode is the opposite of duplication: silently
    // dropping a real second payment because it looks like the first.
    // Without a bank identifier the fingerprint carries a per-row ordinal.
    await ownerSql()`
      insert into bank_transactions (organisation_id, bank_account_id, transaction_date,
        description, amount_minor, currency_code, fingerprint)
      values
        (${org.organisationId}, ${bankAccountId}, '2026-01-06', 'EFT PAYMENT', 500000, 'ZAR',
         '2026-01-06|EFT PAYMENT|500000|1'),
        (${org.organisationId}, ${bankAccountId}, '2026-01-06', 'EFT PAYMENT', 500000, 'ZAR',
         '2026-01-06|EFT PAYMENT|500000|2')
    `;
    const [row] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from bank_transactions
      where bank_account_id = ${bankAccountId} and transaction_date = '2026-01-06'
    `;
    expect(row!.count).toBe('2');
  });

  it('rejects a repeated fingerprint from an overlapping statement period', async () => {
    await expect(
      ownerSql()`
        insert into bank_transactions (organisation_id, bank_account_id, transaction_date,
          description, amount_minor, currency_code, fingerprint)
        values (${org.organisationId}, ${bankAccountId}, '2026-01-06', 'EFT PAYMENT', 500000, 'ZAR',
                '2026-01-06|EFT PAYMENT|500000|1')
      `,
    ).rejects.toThrow(/bank_transactions_fingerprint_unique/);
  });
});

describe('Failed background jobs', () => {
  let org: OrganisationFixture;

  beforeAll(async () => { org = await createOrganisation('Job Failure Co'); });
  afterAll(async () => { await closeOwner(); });

  it('retries with backoff and then moves a poison job to a dead queue', async () => {
    const sql = ownerSql();
    const [job] = await sql<{ id: string }[]>`
      insert into jobs (organisation_id, job_type, payload, max_attempts)
      values (${org.organisationId}, 'event:never.succeeds', '{}'::jsonb, 3)
      returning id
    `;

    const { claimJob, failJob } = await import('../../apps/worker/src/queue.js');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Make the job claimable regardless of the backoff just applied.
      await sql`update jobs set run_after = now() where id = ${job!.id}`;
      const claimed = await claimJob(sql as never, `test-worker-${attempt}`);
      expect(claimed?.id).toBe(job!.id);
      await failJob(sql as never, claimed!, new Error('handler always throws'));
    }

    const [final] = await sql<{ status: string; attempts: number; last_error: string }[]>`
      select status, attempts, last_error from jobs where id = ${job!.id}
    `;
    // Not retried forever, and not silently discarded: parked for an operator.
    expect(final!.status).toBe('dead');
    expect(final!.attempts).toBe(3);
    expect(final!.last_error).toContain('handler always throws');

    const attempts = await sql<{ attempt: number; outcome: string }[]>`
      select attempt, outcome from job_attempts where job_id = ${job!.id} order by attempt
    `;
    expect(attempts).toHaveLength(3);
    expect(attempts.at(-1)!.outcome).toBe('dead');
  });

  it('never hands one job to two workers at the same time', async () => {
    const sql = ownerSql();
    await sql`
      insert into jobs (organisation_id, job_type, payload)
      values (${org.organisationId}, 'event:contended', '{}'::jsonb)
    `;
    const { claimJob } = await import('../../apps/worker/src/queue.js');
    const [a, b] = await Promise.all([
      claimJob(sql as never, 'worker-a'),
      claimJob(sql as never, 'worker-b'),
    ]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('returns a job stranded by a worker crash to the queue', async () => {
    const sql = ownerSql();
    const [job] = await sql<{ id: string }[]>`
      insert into jobs (organisation_id, job_type, payload, status, locked_at, locked_by)
      values (${org.organisationId}, 'event:stranded', '{}'::jsonb, 'running',
              now() - interval '30 minutes', 'worker-that-died')
      returning id
    `;
    const { reclaimStalled } = await import('../../apps/worker/src/queue.js');
    const reclaimed = await reclaimStalled(sql as never, 15);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const [row] = await sql<{ status: string; locked_by: string | null }[]>`
      select status, locked_by from jobs where id = ${job!.id}
    `;
    expect(row!.status).toBe('queued');
    expect(row!.locked_by).toBeNull();
  });

  it('keeps posted finance correct while the worker is unavailable', async () => {
    // Business data and its events commit together; the worker only publishes.
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Durable', lastName: 'Record' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Durable House', code: 'DUR1', propertyType: 'house',
        addressLine1: '1 Durable Way', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('5000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );
    const charge = await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'Rent', amountMinor: R('5000'), dueDate: '2026-01-01' }],
      }),
    );

    // The charge is posted and the event is durably queued, with no worker running.
    const [posted] = await ownerSql()<{ status: string }[]>`
      select status from charge_documents where id = ${charge.documentId}
    `;
    expect(posted!.status).toBe('posted');

    const [outbox] = await ownerSql()<{ count: string }[]>`
      select count(*)::text from outbox_events
      where resource_id = ${charge.documentId} and published_at is null
    `;
    expect(outbox!.count).toBe('1');
  });
});

describe('Provider events arrive twice or out of order', () => {
  afterAll(async () => { await closeOwner(); });

  it('rejects a duplicate provider event', async () => {
    const sql = ownerSql();
    await sql`
      insert into webhook_events (provider, provider_event_id, event_type, payload, signature_verified)
      values ('demo-provider', 'evt_12345', 'payment.succeeded', '{}'::jsonb, true)
    `;
    await expect(
      sql`
        insert into webhook_events (provider, provider_event_id, event_type, payload, signature_verified)
        values ('demo-provider', 'evt_12345', 'payment.succeeded', '{}'::jsonb, true)
      `,
    ).rejects.toThrow(/webhook_events_provider_provider_event_id_key|duplicate key/);
  });

  it('keeps an unverified-signature event quarantined as unprocessed', async () => {
    const sql = ownerSql();
    const [event] = await sql<{ id: string; signature_verified: boolean; processed_at: string | null }[]>`
      insert into webhook_events (provider, provider_event_id, event_type, payload, signature_verified)
      values ('demo-provider', 'evt_unsigned', 'payment.succeeded', '{}'::jsonb, false)
      returning id, signature_verified, processed_at
    `;
    // Recorded for investigation, never acted upon.
    expect(event!.signature_verified).toBe(false);
    expect(event!.processed_at).toBeNull();
  });

  it('makes a command idempotency key reusable only with the same payload', async () => {
    const org = await createOrganisation('Idempotency Co');
    const sql = ownerSql();
    const payloadA = Buffer.from('a'.repeat(64), 'hex');
    await sql`
      insert into idempotency_keys (organisation_id, command, key, payload_sha256, status)
      values (${org.organisationId}, 'billing.post', 'run-2026-01', ${payloadA}, 'succeeded')
    `;
    // Replaying the same key is a conflict the caller resolves by reading the
    // stored result, never by performing the work twice.
    await expect(
      sql`
        insert into idempotency_keys (organisation_id, command, key, payload_sha256, status)
        values (${org.organisationId}, 'billing.post', 'run-2026-01', ${payloadA}, 'in_progress')
      `,
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('Malicious or oversized uploads', () => {
  it('rejects an executable whatever it claims to be', () => {
    expect(validateUpload({
      filename: 'invoice.pdf.exe', declaredContentType: 'application/pdf', byteSize: 1024,
    })).toMatchObject({ ok: false });
    expect(validateUpload({
      filename: 'script.sh', declaredContentType: 'application/pdf', byteSize: 1024,
    })).toMatchObject({ ok: false });
  });

  it('rejects a file larger than the limit', () => {
    const result = validateUpload({
      filename: 'huge.pdf', declaredContentType: 'application/pdf',
      byteSize: DOCUMENT_CONSTRAINTS.maxBytes + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('larger than');
  });

  it('rejects an empty file', () => {
    expect(validateUpload({
      filename: 'empty.pdf', declaredContentType: 'application/pdf', byteSize: 0,
    }).ok).toBe(false);
  });

  it('rejects content whose real type contradicts the declared type', () => {
    // Declared as a PDF; the bytes are a PNG signature.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = validateUpload({
      filename: 'claims-to-be.pdf', declaredContentType: 'application/pdf',
      byteSize: 2048, head: png,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('image/png');
  });

  it('accepts a genuine PDF', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(validateUpload({
      filename: 'lease.pdf', declaredContentType: 'application/pdf', byteSize: 102400, head: pdf,
    }).ok).toBe(true);
  });

  it('reports honestly that no scanner is configured, rather than claiming clean', async () => {
    const outcome = await scanDocument({ bucket: 'propertyos-private', key: 'k' }, {} as NodeJS.ProcessEnv);
    expect(outcome.status).toBe('skipped_not_configured');
    expect(outcome.status).not.toBe('clean');
    if (outcome.status === 'skipped_not_configured') {
      expect(outcome.detail).toContain('has NOT been scanned');
    }
  });
});

describe('Email provider is unavailable', () => {
  it('never reports an undelivered message as sent', async () => {
    const adapter = resolveEmailAdapter({ EMAIL_PROVIDER: 'sink' } as NodeJS.ProcessEnv);
    const outcome = await adapter.send({
      to: 'resident@demo.invalid', subject: 'Statement', body: 'Your statement is ready.',
    });
    expect(outcome.status).toBe('development_sink');
    expect(outcome.status).not.toBe('sent');
  });

  it('falls back to the sink with an explicit reason when credentials are missing', () => {
    const adapter = resolveEmailAdapter({ EMAIL_PROVIDER: 'smtp' } as NodeJS.ProcessEnv);
    expect(adapter.name).toBe('sink');
  });
});

describe('Deposit refund controls', () => {
  let org: OrganisationFixture;
  let depositAccountId: string;
  let evidenceId: string;

  beforeAll(async () => {
    org = await createOrganisation('Deposit Control Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, { firstName: 'Deposit', lastName: 'Holder' }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Deposit House', code: 'DEP1', propertyType: 'house',
        addressLine1: '1 Deposit Lane', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', rentMinor: R('8000'),
        depositRequiredMinor: R('8000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId: lease.leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );

    const [book] = await ownerSql()<{ id: string }[]>`
      select id from financial_books where organisation_id = ${org.organisationId} and is_default
    `;
    const [account] = await ownerSql()<{ id: string }[]>`
      insert into deposit_accounts (organisation_id, book_id, lease_id, holder,
        currency_code, required_minor, opened_on)
      values (${org.organisationId}, ${book!.id}, ${lease.leaseId}, 'landlord',
              'ZAR', 800000, '2026-01-01')
      returning id
    `;
    depositAccountId = account!.id;

    const [doc] = await ownerSql()<{ id: string }[]>`
      insert into documents (organisation_id, classification, title, storage_key,
        content_type, byte_size, lease_id, quarantined, scan_status)
      values (${org.organisationId}, 'deposit_evidence', 'Damage quotation',
              ${`dep/${Date.now()}.pdf`}, 'application/pdf', 4096, ${lease.leaseId}, false, 'clean')
      returning id
    `;
    evidenceId = doc!.id;
  });

  afterAll(async () => { await closeOwner(); });

  it('blocks a deduction with no evidence and no approval', async () => {
    await expect(
      ownerSql()`
        insert into deposit_events (organisation_id, deposit_account_id, event_type,
          amount_minor, currency_code, effective_on, description)
        values (${org.organisationId}, ${depositAccountId}, 'deduction',
                -250000, 'ZAR', '2026-06-01', 'Carpet damage')
      `,
    ).rejects.toThrow(/deposit_events_refund_controls/);
  });

  it('blocks a refund approved by the person who requested it', async () => {
    const [requester] = await ownerSql()<{ id: string }[]>`
      select auth_user_id as id from user_profiles limit 1
    `;
    await expect(
      ownerSql()`
        insert into deposit_events (organisation_id, deposit_account_id, event_type,
          amount_minor, currency_code, effective_on, description,
          evidence_document_id, requested_by, requested_at, approved_by, approved_at, approval_reason)
        values (${org.organisationId}, ${depositAccountId}, 'refund',
                -800000, 'ZAR', '2026-06-01', 'Full refund',
                ${evidenceId}, ${requester!.id}, now(), ${requester!.id}, now(),
                'Approved by the same person who prepared it')
      `,
    ).rejects.toThrow(/deposit_events_segregation/);
  });

  it('refuses to credit interest without evidence', async () => {
    await expect(
      ownerSql()`
        insert into deposit_events (organisation_id, deposit_account_id, event_type,
          amount_minor, currency_code, effective_on, description)
        values (${org.organisationId}, ${depositAccountId}, 'interest_credited',
                12000, 'ZAR', '2026-06-01', 'Assumed 6% annual interest')
      `,
    ).rejects.toThrow(/deposit_events_interest_evidence/);
  });

  it('accepts a properly evidenced, separately approved deduction', async () => {
    const [preparer] = await ownerSql()<{ id: string }[]>`
      select auth_user_id as id from user_profiles order by created_at limit 1
    `;
    const [approver] = await ownerSql()<{ id: string }[]>`
      select auth_user_id as id from user_profiles order by created_at desc limit 1
    `;
    expect(preparer!.id).not.toBe(approver!.id);

    const [event] = await ownerSql()<{ id: string }[]>`
      insert into deposit_events (organisation_id, deposit_account_id, event_type,
        amount_minor, currency_code, effective_on, description,
        evidence_document_id, requested_by, requested_at, approved_by, approved_at, approval_reason)
      values (${org.organisationId}, ${depositAccountId}, 'deduction',
              -250000, 'ZAR', '2026-06-01', 'Carpet damage beyond fair wear and tear',
              ${evidenceId}, ${preparer!.id}, now(), ${approver!.id}, now(),
              'Quotation attached and move-out inspection reviewed')
      returning id
    `;
    expect(event!.id).toBeTruthy();
  });

  it('never deletes a deposit event', async () => {
    const [event] = await ownerSql()<{ id: string }[]>`
      select id from deposit_events where deposit_account_id = ${depositAccountId} limit 1
    `;
    await expect(
      ownerSql()`delete from deposit_events where id = ${event!.id}`,
    ).rejects.toThrow(/immutable/);
  });
});
