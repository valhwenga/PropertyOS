import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, invalid, notFound, parsed } from './errors';
import { requirePlatformPermission, setAccountStatus } from './platform';

/**
 * Spike charging the landlord.
 *
 * The product has had plans, prices, allowances and an overage rate since the
 * first migration and has never charged anybody: a customer could be on the
 * portfolio plan with eleven units over the allowance and owe nothing, because
 * no invoice existed to owe.
 *
 * Three rules shape everything here.
 *
 * **Nothing is charged twice.** A billing run is a button an operator presses
 * again when they are unsure whether the first press worked, so the uniqueness
 * is in the schema — `unique (organisation_id, period_start)` — and this module
 * reports a second run as "already billed" rather than failing or, far worse,
 * issuing a second invoice.
 *
 * **An invoice says only what is configured.** Spike's legal name, address and
 * VAT registration live in a row an operator fills in. With no VAT number there
 * is no tax on the document and it is headed INVOICE, not TAX INVOICE, because
 * a document that calls itself a tax invoice is one a customer's accountant
 * will claim against.
 *
 * **Usage is a snapshot.** The unit count on an invoice is what it was when the
 * run read it, stored on the row. A customer who adds twenty units in April
 * does not retrospectively change what March said.
 */

export interface PlatformBiller {
  legalName: string | null;
  address: string | null;
  email: string | null;
  vatNumber: string | null;
  vatRateBp: number;
  bankDetails: string | null;
  paymentTermsDays: number;
  currencyCode: string;
  /**
   * Whether an invoice can be issued at all. A document with no supplier name
   * or address is not an invoice, it is a number on a page.
   */
  readyToIssue: boolean;
  /** Whether a document issued now would be a tax invoice. */
  chargesVat: boolean;
}

export async function platformBillingSettings(
  tx: Sql,
  authUserId: string,
): Promise<PlatformBiller> {
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');
  const [row] = await tx<
    { legal_name: string | null; address: string | null; email: string | null;
      vat_number: string | null; vat_rate_bp: number; bank_details: string | null;
      payment_terms_days: number; currency_code: string }[]
  >`
    select legal_name, address, email, vat_number, vat_rate_bp, bank_details,
           payment_terms_days, currency_code
      from platform_billing_settings where id
  `;
  if (!row) throw new DomainError('internal', 'Platform billing settings row is missing.');
  return {
    legalName: row.legal_name,
    address: row.address,
    email: row.email,
    vatNumber: row.vat_number,
    vatRateBp: row.vat_rate_bp,
    bankDetails: row.bank_details,
    paymentTermsDays: row.payment_terms_days,
    currencyCode: row.currency_code.trim(),
    readyToIssue: Boolean(row.legal_name?.trim() && row.address?.trim()),
    chargesVat: Boolean(row.vat_number?.trim()),
  };
}

export const billingSettingsSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  address: z.string().trim().min(5).max(500),
  email: z.string().trim().email().optional().or(z.literal('')),
  // Deliberately loose. A South African VAT number is ten digits starting with
  // 4, and Spike may one day invoice from elsewhere; refusing a valid foreign
  // number to enforce a format would be the product being wrong about the
  // world rather than the operator being wrong about their own registration.
  vatNumber: z.string().trim().max(50).optional().or(z.literal('')),
  vatRateBp: z.coerce.number().int().min(0).max(10_000),
  bankDetails: z.string().trim().max(500).optional().or(z.literal('')),
  paymentTermsDays: z.coerce.number().int().min(0).max(90),
});

export async function saveBillingSettings(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof billingSettingsSchema>,
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const s = parsed(billingSettingsSchema, input);

  const [before] = await tx<{ legal_name: string | null; vat_number: string | null }[]>`
    select legal_name, vat_number from platform_billing_settings where id
  `;

  await tx`
    update platform_billing_settings
       set legal_name = ${s.legalName},
           address = ${s.address},
           email = ${s.email || null},
           vat_number = ${s.vatNumber || null},
           vat_rate_bp = ${s.vatRateBp},
           bank_details = ${s.bankDetails || null},
           payment_terms_days = ${s.paymentTermsDays},
           updated_at = now(),
           updated_by = ${operator.authUserId}::uuid
     where id
  `;

  // Audited against no organisation: this is Spike's own record, and writing
  // it into a customer's trail would be putting Spike's business in their file.
  await recordAudit(tx, {
    organisationId: null,
    actorUserId: operator.authUserId,
    action: 'platform.billing_settings.changed',
    resourceType: 'platform_billing_settings',
    resourceId: null,
    before: { legalName: before?.legal_name ?? null, vatRegistered: Boolean(before?.vat_number) },
    after: { legalName: s.legalName, vatRegistered: Boolean(s.vatNumber) },
  });
}

/** Sequential across every customer: this is Spike's own series, not theirs. */
async function nextInvoiceNumber(tx: Sql, issueDate: string): Promise<string> {
  await tx`select pg_advisory_xact_lock(hashtext('spike-subscription-invoice'))`;
  const year = issueDate.slice(0, 4);
  const [row] = await tx<{ next: number }[]>`
    select coalesce(max(substring(invoice_number from '[0-9]+$')::bigint), 0) + 1 as next
      from subscription_invoices
     where invoice_number like ${`SPK-${year}-%`}
  `;
  return `SPK-${year}-${String(row?.next ?? 1).padStart(5, '0')}`;
}

export interface SubscriptionInvoiceLine {
  lineNo: number;
  kind: 'plan' | 'overage';
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
}

export interface SubscriptionInvoice {
  id: string;
  organisationId: string;
  organisationName: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  planKey: string;
  planName: string;
  includedUnits: number;
  billableUnits: number;
  unitsOver: number;
  subtotalMinor: number;
  vatRateBp: number;
  vatMinor: number;
  totalMinor: number;
  supplierVatNumber: string | null;
  /** Who it was addressed to, as at issue. */
  recipientName: string | null;
  recipientAddress: string | null;
  recipientVatNumber: string | null;
  status: 'issued' | 'paid' | 'void';
  paidOn: string | null;
  paidMinor: number | null;
  paymentReference: string | null;
  voidReason: string | null;
  /** Issued, unpaid and past its due date. */
  overdue: boolean;
  lines: SubscriptionInvoiceLine[];
}

export const billingRunSchema = z.object({
  /** The first day of the month being billed. */
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface BillingRunOutcome {
  periodStart: string;
  periodEnd: string;
  issued: Array<{ organisationName: string; invoiceNumber: string; totalMinor: number }>;
  /** Named rather than counted: an operator needs to know WHO was not billed. */
  skipped: Array<{ organisationName: string; reason: string }>;
  totalMinor: number;
}

/**
 * Bills every customer for one month.
 *
 * What is deliberately NOT billed:
 *
 *  * **a trial.** A trial is the state of not paying yet, and invoicing one
 *    would make the word meaningless;
 *  * **a closed account.** Nothing accrues after the relationship ends;
 *  * **a customer already invoiced for this period**, which is the second
 *    press of the button.
 *
 * A **suspended** account IS billed, and that is the consistent position:
 * suspension stops the console and nothing else, their records and their own
 * billing run carry on, and a suspended customer who owed money last month
 * still owes it.
 */
export async function runSubscriptionBilling(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof billingRunSchema>,
): Promise<BillingRunOutcome> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const r = parsed(billingRunSchema, input);

  const biller = await platformBillingSettings(tx, authUserId);
  if (!biller.readyToIssue) {
    throw invalid(
      'Spike\'s own invoicing details are not set. An invoice needs a legal name and an '
        + 'address before it can be issued; fill them in under platform billing settings.',
    );
  }

  // `::text`, not `::date`. A date column comes back from the driver as a JS
  // Date, and comparing a 'YYYY-MM-DD' string with a Date coerces the Date to
  // a number, which makes every such comparison quietly false — so the guard
  // below has never once fired, and the declared type of this outcome
  // (`periodStart: string`) was a Date all along. Two bugs from one implicit
  // conversion.
  const [period] = await tx<{ period_start: string; period_end: string }[]>`
    select (${r.periodStart}::date)::text as period_start,
           ((${r.periodStart}::date + interval '1 month')::date)::text as period_end
  `;
  const periodStart = period!.period_start;
  const periodEnd = period!.period_end;

  if (r.issueDate < periodStart) {
    throw invalid('A period cannot be invoiced before it has started.');
  }

  const customers = await tx<
    { id: string; name: string; status: string; trial_ends_on: string | null;
      currency_code: string;
      plan_key: string; plan_name: string; included_units: number | null;
      monthly_price_minor: string | null; additional_unit_price_minor: string | null;
      billable_units: number; already: string | null;
      recipient_name: string | null; recipient_address: string | null;
      recipient_vat_number: string | null }[]
  >`
    select o.id, o.name, o.status::text, o.currency_code,
           s.trial_ends_on::text as trial_ends_on,
           p.key as plan_key, p.name as plan_name, price.included_units,
           price.monthly_price_minor::text, price.additional_unit_price_minor::text,
           coalesce(u.billable_units, 0) as billable_units,
           (select i.invoice_number from subscription_invoices i
             where i.organisation_id = o.id and i.period_start = ${periodStart}::date)
             as already,
           -- Who to address it to, captured now and frozen on the row. The
           -- customer's own profile is closed to an operator, so this comes
           -- through a definer function that returns these three fields and
           -- nothing else.
           b.legal_name as recipient_name,
           b.physical_address as recipient_address,
           b.vat_number as recipient_vat_number
      from organisations o
      join subscriptions s on s.organisation_id = o.id
      join plans p on p.key = s.plan_key
      -- The price in force on the first day of the period being billed, not
      -- the price today. Billing March in April, after a rise on 1 April,
      -- charged March at April's price before this join existed — and nobody
      -- would have noticed until a customer did.
      -- LEFT, and the skip below says so. An inner join drops a customer
      -- whose plan had no price in force for the period — a plan created this
      -- month, billed for last — and a customer who silently vanishes from a
      -- billing run is the worst available outcome.
      left join lateral app.plan_price_at(p.key, ${periodStart}::date) price on true
      left join app.platform_customer_usage() u on u.organisation_id = o.id
      left join lateral app.platform_customer_billing_identity(o.id) b on true
     order by o.name
  `;

  const outcome: BillingRunOutcome = {
    periodStart, periodEnd, issued: [], skipped: [], totalMinor: 0,
  };

  for (const c of customers) {
    if (c.already) {
      outcome.skipped.push({
        organisationName: c.name,
        reason: `already invoiced for this period as ${c.already}`,
      });
      continue;
    }
    if (c.monthly_price_minor === null) {
      outcome.skipped.push({
        organisationName: c.name,
        reason: `the ${c.plan_name} plan had no price in force on ${periodStart}`,
      });
      continue;
    }
    // A trial is a DATE, not a status. The status says what somebody last set;
    // the date says whether the free period is over. Before this, `trial` with
    // no end date meant every customer ever provisioned was free for ever
    // until an operator remembered to change a dropdown.
    if (c.status === 'trial') {
      const trialEndsOn = c.trial_ends_on;
      if (!trialEndsOn || trialEndsOn > periodStart) {
        outcome.skipped.push({
          organisationName: c.name,
          reason: trialEndsOn
            ? `on trial until ${trialEndsOn} — nothing is charged`
            : 'on trial with no end date — nothing is charged',
        });
        continue;
      }
      // The trial ended before this period began, so this period is chargeable
      // and the account is no longer on trial. Moving it is part of the run
      // rather than a silent flip: it is caused by a commercial event and it is
      // recorded with the reason.
      await setAccountStatus(tx, authUserId, {
        organisationId: c.id,
        status: 'active',
        reason: `Trial ended on ${trialEndsOn}; first invoice issued for ${periodStart}.`,
      });
      await tx`
        update subscriptions set status = 'active', updated_at = now()
        where organisation_id = ${c.id}::uuid and status = 'trialing'
      `;
    }
    if (c.status === 'closed') {
      outcome.skipped.push({ organisationName: c.name, reason: 'account closed' });
      continue;
    }

    const planPrice = Number(c.monthly_price_minor);
    const overagePrice = Number(c.additional_unit_price_minor);
    const billable = Number(c.billable_units);
    const includedUnits = c.included_units ?? 0;
    const unitsOver = Math.max(0, billable - includedUnits);

    const lines: SubscriptionInvoiceLine[] = [{
      lineNo: 1,
      kind: 'plan',
      description: `${c.plan_name} plan — ${periodStart} to ${periodEnd}, ${includedUnits} units included`,
      quantity: 1,
      unitPriceMinor: planPrice,
      amountMinor: planPrice,
    }];
    if (unitsOver > 0 && overagePrice > 0) {
      lines.push({
        lineNo: 2,
        kind: 'overage',
        description: `${unitsOver} unit${unitsOver === 1 ? '' : 's'} above the plan allowance`,
        quantity: unitsOver,
        unitPriceMinor: overagePrice,
        amountMinor: unitsOver * overagePrice,
      });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (subtotal === 0) {
      // The enterprise plan is priced separately and carries no price here.
      // Sending a customer a R0.00 invoice would be noise, and pretending a
      // negotiated price exists in this table would be worse.
      outcome.skipped.push({
        organisationName: c.name,
        reason: `${c.plan_name} carries no price in the plan table — agreed separately`,
      });
      continue;
    }

    // Rounded half up, on the subtotal rather than per line: one rounding for
    // one document, so the total always equals what the lines add to plus the
    // tax shown.
    const vat = biller.chargesVat
      ? Math.round((subtotal * biller.vatRateBp) / 10_000)
      : 0;
    const total = subtotal + vat;

    const invoiceNumber = await nextInvoiceNumber(tx, r.issueDate);
    const [invoice] = await tx<{ id: string }[]>`
      insert into subscription_invoices (
        organisation_id, invoice_number, period_start, period_end, issue_date, due_date,
        currency_code, plan_key, plan_name, included_units, billable_units, units_over,
        subtotal_minor, vat_rate_bp, vat_minor, total_minor, supplier_vat_number, created_by,
        recipient_name, recipient_address, recipient_vat_number
      ) values (
        ${c.id}, ${invoiceNumber}, ${periodStart}, ${periodEnd}, ${r.issueDate},
        (${r.issueDate}::date + ${biller.paymentTermsDays} * interval '1 day')::date,
        ${c.currency_code}, ${c.plan_key}, ${c.plan_name}, ${includedUnits},
        ${billable}, ${unitsOver},
        ${subtotal}, ${biller.chargesVat ? biller.vatRateBp : 0}, ${vat}, ${total},
        ${biller.vatNumber}, ${operator.authUserId}::uuid,
        ${c.recipient_name ?? c.name}, ${c.recipient_address}, ${c.recipient_vat_number}
      )
      returning id
    `;
    if (!invoice) throw new DomainError('internal', 'Subscription invoice insert returned no row.');

    for (const l of lines) {
      await tx`
        insert into subscription_invoice_lines (
          invoice_id, line_no, kind, description, quantity, unit_price_minor, amount_minor
        ) values (
          ${invoice.id}, ${l.lineNo}, ${l.kind}, ${l.description}, ${l.quantity},
          ${l.unitPriceMinor}, ${l.amountMinor}
        )
      `;
    }

    // In the customer's own trail, because being invoiced is something that
    // happened to them and they are entitled to see it there.
    await recordAudit(tx, {
      organisationId: c.id,
      actorUserId: operator.authUserId,
      action: 'platform.subscription.invoiced',
      resourceType: 'subscription_invoice',
      resourceId: invoice.id,
      after: {
        invoiceNumber, periodStart, totalMinor: total, planKey: c.plan_key,
        billableUnits: billable, unitsOver,
      },
    });

    outcome.issued.push({
      organisationName: c.name, invoiceNumber, totalMinor: total,
    });
    outcome.totalMinor += total;
  }

  return outcome;
}

export const recordPaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.coerce.number().int().min(0),
  reference: z.string().trim().min(2, 'Record what the payment was identified by.').max(200),
});

/**
 * Records that an invoice was paid.
 *
 * By hand, because there is no payment provider anywhere in this product: an
 * operator reads Spike's bank statement and records what arrived. The screen
 * says that rather than implying a reconciliation that is not happening.
 *
 * A short payment is recorded as what arrived and left unpaid. Marking an
 * invoice settled for less than it says would make the figure an operator
 * trusts — what customers owe — quietly wrong.
 */
export async function recordSubscriptionPayment(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof recordPaymentSchema>,
): Promise<{ invoiceNumber: string; settled: boolean; shortMinor: number }> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const p = parsed(recordPaymentSchema, input);

  const [invoice] = await tx<
    { id: string; organisation_id: string; invoice_number: string; total_minor: string;
      status: string }[]
  >`
    select id, organisation_id, invoice_number, total_minor::text, status::text
      from subscription_invoices where id = ${p.invoiceId}::uuid
  `;
  if (!invoice) throw notFound('Subscription invoice');
  if (invoice.status === 'void') throw invalid('That invoice has been voided.');
  if (invoice.status === 'paid') throw invalid('That invoice is already recorded as paid.');

  const total = Number(invoice.total_minor);
  const settled = p.amountMinor >= total;
  const shortMinor = Math.max(0, total - p.amountMinor);

  const updated = await tx<{ id: string }[]>`
    update subscription_invoices
       set status = ${settled ? 'paid' : 'issued'},
           paid_on = ${settled ? p.paidOn : null},
           paid_minor = ${p.amountMinor},
           payment_reference = ${p.reference},
           payment_recorded_by = ${operator.authUserId}::uuid
     where id = ${p.invoiceId}::uuid and status = 'issued'
    returning id
  `;
  if (updated.length === 0) {
    throw new DomainError('forbidden', 'That payment could not be recorded against the invoice.');
  }

  await recordAudit(tx, {
    organisationId: invoice.organisation_id,
    actorUserId: operator.authUserId,
    action: 'platform.subscription.payment_recorded',
    resourceType: 'subscription_invoice',
    resourceId: invoice.id,
    reason: p.reference,
    after: { paidMinor: p.amountMinor, settled, shortMinor },
  });

  return { invoiceNumber: invoice.invoice_number, settled, shortMinor };
}

/**
 * Voids an invoice, with a reason.
 *
 * The only way to withdraw a charge. Nothing edits an issued invoice — a
 * trigger refuses it — because a document a customer has already read is not a
 * draft.
 */
export async function voidSubscriptionInvoice(
  tx: Sql,
  authUserId: string,
  params: { invoiceId: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  if (params.reason.trim().length < 5) throw invalid('Voiding an invoice requires a reason.');

  const [invoice] = await tx<
    { id: string; organisation_id: string; invoice_number: string; status: string }[]
  >`
    select id, organisation_id, invoice_number, status::text
      from subscription_invoices where id = ${params.invoiceId}::uuid
  `;
  if (!invoice) throw notFound('Subscription invoice');
  if (invoice.status === 'void') return;
  if (invoice.status === 'paid') {
    throw invalid(
      'That invoice is recorded as paid. Voiding it would leave money received against '
        + 'nothing; raise the correction with the customer first.',
    );
  }

  await tx`
    update subscription_invoices
       set status = 'void', voided_at = now(), void_reason = ${params.reason},
           voided_by = ${operator.authUserId}::uuid
     where id = ${params.invoiceId}::uuid
  `;
  await recordAudit(tx, {
    organisationId: invoice.organisation_id,
    actorUserId: operator.authUserId,
    action: 'platform.subscription.invoice_voided',
    resourceType: 'subscription_invoice',
    resourceId: invoice.id,
    reason: params.reason,
  });
}

function mapInvoice(
  row: {
    id: string; organisation_id: string; organisation_name: string; invoice_number: string;
    period_start: string; period_end: string; issue_date: string; due_date: string;
    currency_code: string; plan_key: string; plan_name: string; included_units: number;
    billable_units: number; units_over: number; subtotal_minor: string; vat_rate_bp: number;
    vat_minor: string; total_minor: string; supplier_vat_number: string | null;
    recipient_name: string | null; recipient_address: string | null;
    recipient_vat_number: string | null;
    status: string; paid_on: string | null; paid_minor: string | null;
    payment_reference: string | null; void_reason: string | null;
  },
  lines: SubscriptionInvoiceLine[],
  today: string,
): SubscriptionInvoice {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    invoiceNumber: row.invoice_number,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currencyCode: row.currency_code.trim(),
    planKey: row.plan_key,
    planName: row.plan_name,
    includedUnits: row.included_units,
    billableUnits: row.billable_units,
    unitsOver: row.units_over,
    subtotalMinor: Number(row.subtotal_minor),
    vatRateBp: row.vat_rate_bp,
    vatMinor: Number(row.vat_minor),
    totalMinor: Number(row.total_minor),
    supplierVatNumber: row.supplier_vat_number,
    recipientName: row.recipient_name,
    recipientAddress: row.recipient_address,
    recipientVatNumber: row.recipient_vat_number,
    status: row.status as 'issued' | 'paid' | 'void',
    paidOn: row.paid_on,
    paidMinor: row.paid_minor === null ? null : Number(row.paid_minor),
    paymentReference: row.payment_reference,
    voidReason: row.void_reason,
    overdue: row.status === 'issued' && row.due_date < today,
    lines,
  };
}

const INVOICE_COLUMNS = `
  i.id, i.organisation_id, o.name as organisation_name, i.invoice_number,
  i.period_start::text, i.period_end::text, i.issue_date::text, i.due_date::text,
  i.currency_code, i.plan_key, i.plan_name, i.included_units, i.billable_units,
  i.units_over, i.subtotal_minor::text, i.vat_rate_bp, i.vat_minor::text,
  i.total_minor::text, i.supplier_vat_number, i.recipient_name, i.recipient_address,
  i.recipient_vat_number, i.status::text, i.paid_on::text,
  i.paid_minor::text, i.payment_reference, i.void_reason
`;

async function linesFor(tx: Sql, invoiceIds: string[]): Promise<Map<string, SubscriptionInvoiceLine[]>> {
  const map = new Map<string, SubscriptionInvoiceLine[]>();
  if (invoiceIds.length === 0) return map;
  const rows = await tx<
    { invoice_id: string; line_no: number; kind: string; description: string;
      quantity: string; unit_price_minor: string; amount_minor: string }[]
  >`
    select invoice_id, line_no, kind, description, quantity::text,
           unit_price_minor::text, amount_minor::text
      from subscription_invoice_lines
     where invoice_id = any(${invoiceIds}::uuid[])
     order by invoice_id, line_no
  `;
  for (const r of rows) {
    const list = map.get(r.invoice_id) ?? [];
    list.push({
      lineNo: r.line_no,
      kind: r.kind as 'plan' | 'overage',
      description: r.description,
      quantity: Number(r.quantity),
      unitPriceMinor: Number(r.unit_price_minor),
      amountMinor: Number(r.amount_minor),
    });
    map.set(r.invoice_id, list);
  }
  return map;
}

/** Every subscription invoice, for Spike. Newest first. */
export async function listSubscriptionInvoices(
  tx: Sql,
  authUserId: string,
  filter: { organisationId?: string; status?: 'issued' | 'paid' | 'void' } = {},
): Promise<SubscriptionInvoice[]> {
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');
  const rows = await tx<Parameters<typeof mapInvoice>[0][]>`
    select ${tx.unsafe(INVOICE_COLUMNS)}
      from subscription_invoices i
      join organisations o on o.id = i.organisation_id
     where (${filter.organisationId ?? null}::uuid is null
            or i.organisation_id = ${filter.organisationId ?? null}::uuid)
       and (${filter.status ?? null}::text is null
            or i.status::text = ${filter.status ?? null}::text)
     order by i.issue_date desc, i.invoice_number desc
     limit 500
  `;
  const lines = await linesFor(tx, rows.map((r) => r.id));
  const [today] = await tx<{ d: string }[]>`select current_date::text as d`;
  return rows.map((r) => mapInvoice(r, lines.get(r.id) ?? [], today!.d));
}

/**
 * One customer's own subscription invoices.
 *
 * Read under their RLS context: the policy is
 * `organisation.settings.manage`, because what Spike charges is commercial
 * information about the business, in the same class as its banking details.
 */
export async function customerSubscriptionInvoices(
  tx: Sql,
  organisationId: string,
): Promise<SubscriptionInvoice[]> {
  const rows = await tx<Parameters<typeof mapInvoice>[0][]>`
    select ${tx.unsafe(INVOICE_COLUMNS)}
      from subscription_invoices i
      join organisations o on o.id = i.organisation_id
     where i.organisation_id = ${organisationId}::uuid
     order by i.period_start desc
     limit 100
  `;
  const lines = await linesFor(tx, rows.map((r) => r.id));
  const [today] = await tx<{ d: string }[]>`select current_date::text as d`;
  return rows.map((r) => mapInvoice(r, lines.get(r.id) ?? [], today!.d));
}

/**
 * One invoice, under whichever RLS context the caller has.
 *
 * The same function serves the customer's download and the operator's: who may
 * read which invoice is the policies' business, and a caller who may not read
 * it gets nothing rather than a refusal naming a document they cannot see.
 */
export async function subscriptionInvoiceById(
  tx: Sql,
  invoiceId: string,
): Promise<SubscriptionInvoice | null> {
  const rows = await tx<Parameters<typeof mapInvoice>[0][]>`
    select ${tx.unsafe(INVOICE_COLUMNS)}
      from subscription_invoices i
      join organisations o on o.id = i.organisation_id
     where i.id = ${invoiceId}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  const lines = await linesFor(tx, [row.id]);
  const [today] = await tx<{ d: string }[]>`select current_date::text as d`;
  return mapInvoice(row, lines.get(row.id) ?? [], today!.d);
}

/** The supplier details printed on an invoice, readable by whoever holds one. */
export async function billerForInvoice(tx: Sql): Promise<{
  legalName: string | null; address: string | null; email: string | null;
  vatNumber: string | null; bankDetails: string | null; currencyCode: string;
} | null> {
  const [row] = await tx<
    { legal_name: string | null; address: string | null; email: string | null;
      vat_number: string | null; bank_details: string | null; currency_code: string }[]
  >`select * from app.platform_biller()`;
  if (!row) return null;
  return {
    legalName: row.legal_name,
    address: row.address,
    email: row.email,
    vatNumber: row.vat_number,
    bankDetails: row.bank_details,
    currencyCode: row.currency_code.trim(),
  };
}
