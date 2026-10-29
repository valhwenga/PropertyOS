import postgres from 'postgres';
import { sealField } from '@propertyos/integrations';

/**
 * Putting one corner of the demo data back to a known state.
 *
 * The browser specs run against a preview whose database is NOT reset between
 * runs, and these specs change exactly the state they then assert on: a support
 * access window left open by an earlier run makes Spike's next session arrive
 * already approved, so "waiting on the customer" never appears and the spec
 * reads as a product failure rather than as leftover state.
 *
 * Done in SQL rather than by clicking, which is the version this replaces: the
 * clicking one had to find and press a button per leftover row, and sat there
 * for fifteen minutes when a click did not change what it expected. A fixture
 * reset is not the behaviour under test, so it should not be driven through the
 * behaviour under test. `sign-in.ts` reads the TOTP secret the same way.
 */
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/propertyos_dev';

/**
 * No open support window, no live or waiting session, and an account its staff
 * can actually sign in to.
 *
 * The account status is part of this for a reason found the hard way: a run of
 * the suspension spec that was interrupted before it restored the account left
 * the demo organisation suspended, so every later run signed the landlord in,
 * was redirected to the account-suspended page as designed, and sat waiting
 * fifteen minutes for a settings page it was never going to be shown.
 */
export async function clearSupportAccess(slug: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from organisations where slug = ${slug}
    `;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);

    await sql`
      update support_sessions set revoked_at = now()
       where organisation_id = ${org.id} and revoked_at is null
    `;
    await sql`
      update support_access_grants set revoked_at = now()
       where organisation_id = ${org.id} and revoked_at is null
    `;
    await sql`
      update organisations set status = 'active'
       where id = ${org.id} and status in ('suspended', 'closed')
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Puts a lease's term in the past, and hands back where to find it.
 *
 * The demo's leases run into 2027, and the behaviour under test is what
 * happens when a term has actually run out — so the fixture moves the date
 * rather than the test waiting a year. In SQL for the same reason the support
 * reset is: this is setup, not the behaviour under test, and driving it
 * through the screens would be testing the screens twice.
 */
export async function endLeaseTermYesterday(
  slug: string,
): Promise<{ leaseId: string; reference: string }> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [lease] = await sql<{ id: string; reference: string }[]>`
      update leases set end_date = current_date - 1
       where id = (
         select l.id from leases l
           join organisations o on o.id = l.organisation_id
          where o.slug = ${slug} and l.status = 'active'
          order by l.reference
          limit 1
       )
      returning id, reference
    `;
    if (!lease) throw new Error(`no active lease in ${slug} to end`);
    return { leaseId: lease.id, reference: lease.reference };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Removes this demo's inspection responses, so a run starts from unanswered.
 *
 * The demo database is not reset between runs and the first run answers the
 * report, so a later run looking for "Waiting on you" finds a report it has
 * already agreed with.
 */
export async function clearInspectionResponses(slug: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`
      delete from inspection_acknowledgements
       where organisation_id = (select id from organisations where slug = ${slug})
    `;
    // The status is derived from those rows, and with them gone it belongs
    // back at finalised. Written directly rather than through
    // `app.sync_inspection_response_status()`, which refuses a caller who is
    // neither a member of the organisation nor a resident of the lease — this
    // connection is the fixture's owner and is neither. Doing it here is the
    // honest option: the function is the product's path and this is setup.
    await sql`
      update inspections set status = 'finalised'
       where organisation_id = (select id from organisations where slug = ${slug})
         and status in ('acknowledged', 'disputed')
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * No extra permissions on any of this customer's roles.
 *
 * The grant spec asserts both the presence and the absence of the customer's
 * notice, so a leftover grant from an interrupted run would make the "nothing
 * extra" assertion fail for a reason that has nothing to do with the test.
 */
export async function clearPermissionOverrides(slug: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from organisations where slug = ${slug}
    `;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);
    await sql`
      delete from organisation_role_permissions where organisation_id = ${org.id}
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Every setting back to what the product ships with.
 *
 * A flag left off by an interrupted run is the worst kind of leftover: the
 * next spec signs a resident in, the portal resolves no lease, and the failure
 * looks like a broken portal rather than a test that did not tidy up.
 */
export async function clearSettings(): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from organisation_setting_values`;
    await sql`delete from platform_setting_values`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * No price scheduled ahead of today on any plan.
 *
 * The pricing spec asserts how many prices are in force and that a scheduled
 * one appears; a leftover from an interrupted run makes both read wrongly. It
 * deliberately touches only FUTURE prices: a price that has started is what
 * invoices were issued against.
 */
export async function clearScheduledPrices(): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from plan_prices where effective_from > current_date`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Dead jobs to look at.
 *
 * The queue screen cannot be exercised against a healthy demo database,
 * because a healthy one has nothing on it. These are prefixed `demo.spec.` so
 * the cleanup below can remove exactly what the spec made and nothing a real
 * failure left behind.
 */
export async function seedDeadJobs(
  jobType: string,
  count: number,
  error: string,
): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from organisations where slug = 'demo-blue-crane'
    `;
    for (let i = 0; i < count; i += 1) {
      const [job] = await sql<{ id: string }[]>`
        insert into jobs (
          organisation_id, job_type, payload, status, attempts, max_attempts,
          last_error, completed_at
        ) values (
          ${org?.id ?? null}, ${jobType},
          ${sql.json({ resourceId: '00000000-0000-0000-0000-000000000001' } as never)},
          'dead', 5, 5, ${error}, now()
        )
        returning id::text
      `;
      await sql`
        insert into job_attempts (job_id, attempt, finished_at, outcome, error)
        values (${job!.id}::bigint, 5, now(), 'dead', ${error})
      `;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Removes only what the job spec created. */
export async function clearTestJobs(): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from jobs where job_type like 'demo.spec.%'`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A closed demo customer put back exactly as it was.
 *
 * Offboarding is the one area whose leftovers are not cosmetic: a demo
 * organisation left `closed` sends every later spec that signs its staff in to
 * the closed page instead of the console, and the failures read as a broken
 * console rather than as a test that did not tidy up.
 */
export async function reopenAccount(slug: string, status = 'active'): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from organisations where slug = ${slug}
    `;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);
    await sql`delete from organisation_closures where organisation_id = ${org.id}`;
    await sql`update organisations set status = ${status} where id = ${org.id}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Recovery requests from an earlier run, which would block a fresh ask. */
export async function clearRecoveryRequests(): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from recovery_requests`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Alert silences and raised notices from an earlier run. */
export async function clearAlertState(): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from platform_alert_silences`;
    await sql`delete from platform_alert_notices`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * One issued subscription invoice for a demo customer, and nothing else.
 *
 * The browser test for paying needs something to pay. Billing runs are
 * month-keyed and one per period, so this uses a period far enough back that
 * it cannot collide with a run somebody did in the preview.
 */
export async function seedPayableInvoice(
  slug: string, totalMinor = 115_000,
): Promise<{ invoiceNumber: string }> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`select id from organisations where slug = ${slug}`;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);
    const invoiceNumber = `SPK-E2E-${Date.now().toString(36).toUpperCase()}`;
    await sql`
      insert into subscription_invoices (
        organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
        currency_code, plan_key, plan_name, included_units, billable_units, units_over,
        subtotal_minor, vat_rate_bp, vat_minor, total_minor, status
      ) values (
        ${org.id}, ${invoiceNumber},
        (date_trunc('month', current_date) - interval '11 months')::date,
        (date_trunc('month', current_date) - interval '10 months 1 day')::date,
        current_date, current_date + 14, 'ZAR', 'starter', 'Starter', 10, 1, 0,
        ${Math.round(totalMinor / 1.15)}, 1500,
        ${totalMinor - Math.round(totalMinor / 1.15)}, ${totalMinor}, 'issued'
      )
    `;
    return { invoiceNumber };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The invoices and payment attempts an e2e run created. */
export async function clearPaymentTestData(): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`
      delete from subscription_payment_attempts
      where invoice_id in (
        select id from subscription_invoices where invoice_number like 'SPK-E2E-%'
      )
    `;
    await sql`
      delete from subscription_dunning_steps
      where invoice_id in (
        select id from subscription_invoices where invoice_number like 'SPK-E2E-%'
      )
    `;
    await sql`delete from subscription_invoices where invoice_number like 'SPK-E2E-%'`;
    await sql`delete from webhook_events where provider = 'sandbox'`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Mandates an e2e run created, and the events behind them. */
export async function clearMandates(slug: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`select id from organisations where slug = ${slug}`;
    if (org) await sql`delete from subscription_mandates where organisation_id = ${org.id}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * An authenticated mandate for a demo customer, as a payer's bank would leave
 * one.
 *
 * The account number is sealed properly rather than stubbed: submitting a
 * collection opens it, so a placeholder cipher makes the submission throw —
 * which is exactly how the first version of this helper failed, silently, in
 * the browser.
 */
export async function seedAuthenticatedMandate(
  slug: string, authorisedMinor = 500_000,
): Promise<{ reference: string }> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`select id from organisations where slug = ${slug}`;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);
    await sql`delete from subscription_mandates where organisation_id = ${org.id}`;
    const [event] = await sql<{ id: string }[]>`
      insert into webhook_events (
        provider, provider_event_id, event_type, signature_verified, payload
      ) values (
        'sandbox', ${`e2e-man-${Date.now().toString(36)}`}, 'mandate.authenticated', true,
        '{}'::jsonb
      )
      returning id
    `;
    const reference = `MAN-E2E-${Date.now().toString(36).toUpperCase()}`;
    await sql`
      insert into subscription_mandates (
        organisation_id, provider, reference, authorised_amount_minor, currency_code,
        collection_day, first_collection_on, account_holder, bank_name, branch_code,
        account_type, account_number_cipher, account_number_last4, status,
        authenticated_at, authentication_event_id
      ) values (
        ${org.id}, 'sandbox', ${reference}, ${authorisedMinor}, 'ZAR', 1,
        (date_trunc('month', current_date) - interval '1 month')::date,
        'Blue Crane Properties (Pty) Ltd', 'Standard Bank', '051001', 'cheque',
        ${sealField('62001234567', `mandate_account:${org.id}`)}, '4567',
        'authenticated', now(), ${event!.id}
      )
    `;
    return { reference };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Collections an e2e run prepared, and the mandates behind them. */
export async function clearCollections(slug: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`select id from organisations where slug = ${slug}`;
    if (org) {
      await sql`delete from subscription_collections where organisation_id = ${org.id}`;
      await sql`delete from subscription_mandates where organisation_id = ${org.id}`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * An invoice that fell due in the past, and the chasing that would have
 * happened by now.
 *
 * The browser test is about the screen and the decision a person makes on it,
 * so the ladder it finds is seeded rather than climbed: the integration suite
 * already proves the pass produces exactly these steps at exactly these
 * thresholds. Cleared by `clearPaymentTestData`, which the invoice number
 * prefix puts it in the way of.
 */
export async function seedOverdueInvoice(
  slug: string,
  options: {
    daysOverdue: number; totalMinor?: number; steps?: string[];
    /** Which past month the invoice is for. One invoice per customer per
     *  period is a database constraint, so two seeded debts need two. */
    monthsBack?: number;
  },
): Promise<{ invoiceNumber: string }> {
  const totalMinor = options.totalMinor ?? 115_000;
  const monthsBack = options.monthsBack ?? 11;
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`select id from organisations where slug = ${slug}`;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);
    const invoiceNumber = `SPK-E2E-${Date.now().toString(36).toUpperCase()}`;
    // Issued long enough ago that the due date can be in the past: 0067 freezes
    // the issue date of an issued invoice, and the due date cannot precede it.
    const [invoice] = await sql<{ id: string }[]>`
      insert into subscription_invoices (
        organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
        currency_code, plan_key, plan_name, included_units, billable_units, units_over,
        subtotal_minor, vat_rate_bp, vat_minor, total_minor, status
      ) values (
        ${org.id}, ${invoiceNumber},
        (date_trunc('month', current_date) - make_interval(months => ${monthsBack}))::date,
        (date_trunc('month', current_date) - make_interval(months => ${monthsBack - 1})
          - interval '1 day')::date,
        current_date - 90, (current_date - ${options.daysOverdue}::integer), 'ZAR',
        'starter', 'Starter', 10, 1, 0,
        ${Math.round(totalMinor / 1.15)}, 1500,
        ${totalMinor - Math.round(totalMinor / 1.15)}, ${totalMinor}, 'issued'
      )
      returning id
    `;
    for (const step of options.steps ?? []) {
      await sql`
        insert into subscription_dunning_steps (
          invoice_id, organisation_id, step, days_overdue
        ) values (
          ${invoice!.id}, ${org.id}, ${step}, ${options.daysOverdue}
        )
        on conflict (invoice_id, step) do nothing
      `;
    }
    return { invoiceNumber };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
