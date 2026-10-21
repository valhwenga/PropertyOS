import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  changePlan, createProperty, createUnit, customerSubscriptionInvoices,
  listSubscriptionInvoices, platformBillingSettings, recordSubscriptionPayment,
  runSubscriptionBilling, saveBillingSettings, setAccountStatus, voidSubscriptionInvoice,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories';

/**
 * Spike charging the landlord, which the product has never done.
 *
 * Plans, prices, allowances and an overage rate have existed since the first
 * migration: a customer could be on the portfolio plan with units over the
 * allowance and owe nothing, because no invoice existed to owe. These tests
 * assert the three things that would cost somebody real money if they were
 * wrong — nobody is billed twice, nobody is billed who should not be, and the
 * arithmetic on the document is the arithmetic of the plan.
 */
describe('Subscription billing', () => {
  let operator: string;
  let active: OrganisationFixture;
  let closed: OrganisationFixture;

  beforeAll(async () => {
    operator = await createAuthUser('Billing Operator', { platformOperator: true });

    active = await createOrganisation('Billed Co', { planKey: 'starter' });
    // Created for its state rather than its handle: a customer still on trial,
    // which the run must skip by name.
    await createOrganisation('Trialling Co', { planKey: 'starter' });
    closed = await createOrganisation('Gone Co', { planKey: 'starter' });

    // Twelve units on a ten-unit plan: two over, at the plan's overage price.
    const property = await as(active.adminUserId, (tx) =>
      createProperty(tx, active.organisationId, active.adminUserId, {
        name: 'Billed Block', code: 'BIL', propertyType: 'apartment_block',
        addressLine1: '5 Billed Street', city: 'Cape Town',
      }),
    );
    await as(operator, (tx) =>
      setAccountStatus(tx, operator, {
        organisationId: active.organisationId, status: 'active',
        reason: 'Signed up and paying',
      }),
    );
    // The allowance is enforced, so the plan has to be big enough to hold the
    // units and then be moved back down — which is also the realistic case: a
    // customer grows past the plan they are on.
    await as(operator, (tx) =>
      changePlan(tx, operator, {
        organisationId: active.organisationId, planKey: 'portfolio',
        reason: 'Room for the units this fixture adds, ticket SPK-8001',
      }),
    );
    for (let i = 1; i <= 12; i += 1) {
      await as(active.adminUserId, (tx) =>
        createUnit(tx, active.organisationId, active.adminUserId, {
          propertyId: property.propertyId, code: `B${i}`,
        }),
      );
    }
    // Back to starter, which is the realistic shape of an overage: a customer
    // grew past the plan they are on rather than signing up over it.
    await as(operator, (tx) =>
      changePlan(tx, operator, {
        organisationId: active.organisationId, planKey: 'starter',
        reason: 'Downgraded at their request, ticket SPK-8002',
      }),
    );

    await as(operator, (tx) =>
      setAccountStatus(tx, operator, {
        organisationId: closed.organisationId, status: 'closed',
        reason: 'Customer left at the end of March',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('refuses to issue anything before Spike has its own invoicing details', async () => {
    const settings = await as(operator, (tx) => platformBillingSettings(tx, operator));
    expect(settings.readyToIssue).toBe(false);
    expect(settings.chargesVat).toBe(false);

    await expect(
      as(operator, (tx) =>
        runSubscriptionBilling(tx, operator, {
          periodStart: '2026-03-01', issueDate: '2026-03-01',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('issues one invoice per payable customer, and names who was skipped', async () => {
    await as(operator, (tx) =>
      saveBillingSettings(tx, operator, {
        legalName: 'Spike Technologies (Pty) Ltd',
        address: '1 Example Road, Cape Town, 8001',
        email: 'billing@example.invalid',
        vatNumber: '',               // not a registered vendor yet
        vatRateBp: 1500,
        bankDetails: 'Example Bank, 1234567890',
        paymentTermsDays: 14,
      }),
    );

    const run = await as(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-03-01', issueDate: '2026-03-01',
      }),
    );

    const billed = run.issued.find((i) => i.organisationName === 'Billed Co');
    expect(billed).toBeDefined();

    const skippedTrial = run.skipped.find((s) => s.organisationName === 'Trialling Co');
    const skippedClosed = run.skipped.find((s) => s.organisationName === 'Gone Co');
    // Named rather than counted: an operator needs to know WHO was not billed.
    expect(skippedTrial?.reason).toContain('trial');
    expect(skippedClosed?.reason).toContain('closed');
  });

  it('charges the plan and the overage, and shows both as lines', async () => {
    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: active.organisationId }),
    );
    expect(invoice).toBeDefined();

    // Starter: R299.00 a month, ten units included, R12.00 per unit over.
    expect(invoice!.includedUnits).toBe(10);
    expect(invoice!.billableUnits).toBe(12);
    expect(invoice!.unitsOver).toBe(2);
    expect(invoice!.subtotalMinor).toBe(29_900 + 2 * 1_200);
    expect(invoice!.lines.map((l) => l.kind)).toEqual(['plan', 'overage']);
    expect(invoice!.lines[1]!.quantity).toBe(2);
    expect(invoice!.lines[1]!.amountMinor).toBe(2_400);
    // The lines add up to the subtotal. A document whose lines do not add up to
    // its total is the thing the blueprint warns about most.
    expect(invoice!.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(invoice!.subtotalMinor);
  });

  it('shows no tax, and does not call itself a tax invoice, until Spike is a vendor', async () => {
    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: active.organisationId }),
    );
    expect(invoice!.vatMinor).toBe(0);
    expect(invoice!.vatRateBp).toBe(0);
    expect(invoice!.supplierVatNumber).toBeNull();
    expect(invoice!.totalMinor).toBe(invoice!.subtotalMinor);
  });

  it('is a no-op the second time the button is pressed', async () => {
    const before = await as(operator, (tx) => listSubscriptionInvoices(tx, operator));
    const again = await as(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-03-01', issueDate: '2026-03-01',
      }),
    );
    const after = await as(operator, (tx) => listSubscriptionInvoices(tx, operator));

    expect(after).toHaveLength(before.length);
    expect(again.issued).toHaveLength(0);
    expect(again.skipped.find((s) => s.organisationName === 'Billed Co')?.reason)
      .toContain('already invoiced');
  });

  it('puts tax on the next period once a VAT number is recorded', async () => {
    await as(operator, (tx) =>
      saveBillingSettings(tx, operator, {
        legalName: 'Spike Technologies (Pty) Ltd',
        address: '1 Example Road, Cape Town, 8001',
        email: 'billing@example.invalid',
        vatNumber: '4000000000',
        vatRateBp: 1500,
        bankDetails: 'Example Bank, 1234567890',
        paymentTermsDays: 14,
      }),
    );

    await as(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-04-01', issueDate: '2026-04-01',
      }),
    );
    const invoices = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: active.organisationId }),
    );
    const april = invoices.find((i) => i.periodStart === '2026-04-01')!;
    expect(april.supplierVatNumber).toBe('4000000000');
    expect(april.vatMinor).toBe(Math.round((april.subtotalMinor * 1500) / 10_000));
    expect(april.totalMinor).toBe(april.subtotalMinor + april.vatMinor);

    // And March, already issued, still reads the way it read when it was sent.
    const march = invoices.find((i) => i.periodStart === '2026-03-01')!;
    expect(march.supplierVatNumber).toBeNull();
    expect(march.vatMinor).toBe(0);
  });

  it('captures who it was addressed to, through the only route an operator has', async () => {
    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: active.organisationId }),
    );
    // `organisation_profiles` is customer data and an operator holds no
    // membership, so the run reads these three fields — and only these — through
    // `app.platform_customer_billing_identity()`. Without it the invoice would
    // have no recipient, and an invoice without a recipient is not a tax
    // invoice. Asserted against what the customer actually has recorded.
    const [profile] = await ownerSql()<{ legal_name: string | null }[]>`
      select legal_name from organisation_profiles
       where organisation_id = ${active.organisationId}
    `;
    expect(invoice!.recipientName).toBe(profile?.legal_name ?? 'Billed Co');

    // And the operator cannot reach anything else through that function: it
    // returns three columns, so there is nothing else to reach.
    const direct = await as(operator, (tx) =>
      tx`select legal_name from organisation_profiles
          where organisation_id = ${active.organisationId}::uuid`,
    );
    expect(direct).toHaveLength(0);
  });

  it('refuses to edit what an issued invoice charged', async () => {
    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: active.organisationId }),
    );
    await expect(
      ownerSql()`
        update subscription_invoices set total_minor = 1, subtotal_minor = 1
         where id = ${invoice!.id}
      `,
    ).rejects.toThrow(/cannot be changed/);
  });
});

describe('Being paid, and withdrawing a charge', () => {
  let operator: string;
  let org: OrganisationFixture;
  let invoiceId: string;
  let totalMinor: number;

  beforeAll(async () => {
    operator = await createAuthUser('Payment Operator', { platformOperator: true });
    org = await createOrganisation('Paying Co', { planKey: 'starter' });
    await as(operator, (tx) =>
      setAccountStatus(tx, operator, {
        organisationId: org.organisationId, status: 'active', reason: 'Paying customer',
      }),
    );
    await as(operator, (tx) =>
      saveBillingSettings(tx, operator, {
        legalName: 'Spike Technologies (Pty) Ltd',
        address: '1 Example Road, Cape Town, 8001',
        email: '', vatNumber: '', vatRateBp: 1500, bankDetails: '', paymentTermsDays: 14,
      }),
    );
    const run = await as(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-05-01', issueDate: '2026-05-01',
      }),
    );
    expect(run.issued.length).toBeGreaterThan(0);
    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: org.organisationId }),
    );
    invoiceId = invoice!.id;
    totalMinor = invoice!.totalMinor;
  });

  afterAll(async () => { await closeOwner(); });

  it('records a short payment as what arrived, and leaves the invoice unpaid', async () => {
    const result = await as(operator, (tx) =>
      recordSubscriptionPayment(tx, operator, {
        invoiceId, paidOn: '2026-05-10', amountMinor: totalMinor - 5_000,
        reference: 'EFT 20260510 BILLED',
      }),
    );
    expect(result.settled).toBe(false);
    expect(result.shortMinor).toBe(5_000);

    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: org.organisationId }),
    );
    // Marking it settled for less than it says would make "what customers owe"
    // quietly wrong, which is the one figure this whole area exists to produce.
    expect(invoice!.status).toBe('issued');
    expect(invoice!.paidMinor).toBe(totalMinor - 5_000);
  });

  it('settles it when the rest arrives', async () => {
    const result = await as(operator, (tx) =>
      recordSubscriptionPayment(tx, operator, {
        invoiceId, paidOn: '2026-05-12', amountMinor: totalMinor,
        reference: 'EFT 20260512 BALANCE',
      }),
    );
    expect(result.settled).toBe(true);

    const [invoice] = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: org.organisationId }),
    );
    expect(invoice!.status).toBe('paid');
    expect(invoice!.paidOn).toBe('2026-05-12');
  });

  it('will not void an invoice that has been paid', async () => {
    await expect(
      as(operator, (tx) =>
        voidSubscriptionInvoice(tx, operator, {
          invoiceId, reason: 'Trying to void something already settled',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('voids an unpaid invoice with a reason, and cannot reinstate it', async () => {
    await as(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-06-01', issueDate: '2026-06-01',
      }),
    );
    const invoices = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: org.organisationId }),
    );
    const june = invoices.find((i) => i.periodStart === '2026-06-01')!;

    await as(operator, (tx) =>
      voidSubscriptionInvoice(tx, operator, {
        invoiceId: june.id, reason: 'Billed on the wrong plan after an upgrade',
      }),
    );
    const after = await as(operator, (tx) =>
      listSubscriptionInvoices(tx, operator, { organisationId: org.organisationId }),
    );
    const voided = after.find((i) => i.id === june.id)!;
    expect(voided.status).toBe('void');
    expect(voided.voidReason).toContain('wrong plan');

    await expect(
      ownerSql()`update subscription_invoices set status = 'issued' where id = ${june.id}`,
    ).rejects.toThrow(/cannot be reinstated/);
  });
});

describe('What the customer can see of their own bill', () => {
  let operator: string;
  let org: OrganisationFixture;
  let other: OrganisationFixture;
  let preparer: string;

  beforeAll(async () => {
    operator = await createAuthUser('Visibility Operator', { platformOperator: true });
    org = await createOrganisation('Reading Co', { planKey: 'starter' });
    other = await createOrganisation('Other Reading Co', { planKey: 'starter' });
    preparer = await addMember(org.organisationId, 'Reading Preparer', ['finance_preparer']);

    for (const o of [org, other]) {
      await as(operator, (tx) =>
        setAccountStatus(tx, operator, {
          organisationId: o.organisationId, status: 'active', reason: 'Paying customer',
        }),
      );
    }
    await as(operator, (tx) =>
      saveBillingSettings(tx, operator, {
        legalName: 'Spike Technologies (Pty) Ltd',
        address: '1 Example Road, Cape Town, 8001',
        email: '', vatNumber: '', vatRateBp: 1500, bankDetails: '', paymentTermsDays: 14,
      }),
    );
    await as(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-07-01', issueDate: '2026-07-01',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  it('shows an administrator their own invoices, with the lines', async () => {
    const invoices = await as(org.adminUserId, (tx) =>
      customerSubscriptionInvoices(tx, org.organisationId),
    );
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices[0]!.lines.length).toBeGreaterThan(0);
    expect(invoices[0]!.organisationId).toBe(org.organisationId);
  });

  it('shows nothing to a member who does not manage the organisation', async () => {
    // What Spike charges is commercial information about the business, in the
    // same class as its banking details — not something every colleague reads.
    const invoices = await as(preparer, (tx) =>
      customerSubscriptionInvoices(tx, org.organisationId),
    );
    expect(invoices).toHaveLength(0);
  });

  it('shows nothing of another customer, to anybody', async () => {
    const invoices = await as(org.adminUserId, (tx) =>
      customerSubscriptionInvoices(tx, other.organisationId),
    );
    expect(invoices).toHaveLength(0);
  });

  it('isolates the invoice LINES, which carry no organisation of their own', async () => {
    // The schema invariant that every customer table carries an
    // `organisation_id` is exempted for `subscription_invoice_lines`, on the
    // grounds that the organisation is on the invoice and the lines' policies
    // read it from there. That exemption is only honest if this passes.
    const mine = await as(org.adminUserId, (tx) =>
      tx`select id from subscription_invoice_lines`,
    );
    expect(mine.length).toBeGreaterThan(0);

    const [theirs] = await ownerSql()<{ id: string }[]>`
      select l.id from subscription_invoice_lines l
        join subscription_invoices i on i.id = l.invoice_id
       where i.organisation_id = ${other.organisationId}
       limit 1
    `;
    expect(theirs).toBeDefined();

    const leaked = await as(org.adminUserId, (tx) =>
      tx`select id from subscription_invoice_lines where id = ${theirs!.id}::uuid`,
    );
    expect(leaked).toHaveLength(0);
  });
});
