/**
 * The price list, and the date on every price.
 *
 * `plans` carried a price from the first migration and nothing ever wrote to
 * it: launching a tier or raising R899 meant a deploy. The obvious fix —
 * editable price columns — is wrong in a way only the billing run exposes, and
 * the first test below is that bug written down: the run read the price AT THE
 * MOMENT IT RAN, so invoicing March in April after a rise on 1 April would
 * charge March at April's price.
 *
 * What these pin:
 *   1. a period is billed at the price in force for THAT period;
 *   2. a price over a period already invoiced is refused, because an issued
 *      invoice is never rewritten and the two would disagree for ever;
 *   3. a plan always has a price, and a new tier gets one in the same
 *      transaction;
 *   4. retiring a plan stops it being offered and does not move anybody off it;
 *   5. allowances follow the price list, today.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPlan, createStandaloneHouse, listPlans, planCatalogue, planRevenueAt,
  removePlanPrice, runSubscriptionBilling, saveBillingSettings, setPlanActive,
  setPlanEntitlement, setPlanPrice,
} from '@propertyos/domain';
import {
  as, asPlatformOperator, closeOwner, createAuthUser, createOrganisation, ownerSql,
  type OrganisationFixture,
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

describe('the price list', () => {
  let operator: string;
  let org: OrganisationFixture;
  let planKey: string;

  beforeAll(async () => {
    operator = await createOperator('Spike Pricer');
    planKey = `tier_${Date.now().toString(36)}`;

    await asPlatformOperator(operator, (tx) =>
      createPlan(tx, operator, {
        key: planKey, name: 'Test tier', currencyCode: 'ZAR',
        includedUnits: 10, monthlyPriceMinor: 89_900, additionalUnitPriceMinor: 5_000,
        reason: 'A tier for the pricing tests.',
      }),
    );
    // `createPlan` prices from today, and these tests bill periods in the
    // past, so back-date the first price. A plan with no price for the period
    // is skipped by name — asserted in its own test below.
    await ownerSql()`
      update plan_prices set effective_from = date '2026-01-01'
       where plan_key = ${planKey}
    `;

    org = await createOrganisation('Priced Co', { planKey: 'portfolio' });
    await ownerSql()`
      update subscriptions set plan_key = ${planKey}, status = 'active'
       where organisation_id = ${org.organisationId}
    `;
    // The run skips an organisation on TRIAL, which is the account's own
    // status rather than the subscription's — a fixture that sets only the
    // subscription is billed for nothing and reads as a pricing bug.
    await ownerSql()`
      update organisations set status = 'active' where id = ${org.organisationId}
    `;

    // An invoice cannot be issued until Spike's own billing identity is
    // filled in, which is migration 0067's rule and nothing to do with prices.
    await asPlatformOperator(operator, (tx) =>
      saveBillingSettings(tx, operator, {
        legalName: 'Spike Technologies (Pty) Ltd',
        address: '1 Example Road, Cape Town, 8001',
        email: 'billing@example.invalid',
        vatNumber: '',
        vatRateBp: 1500,
        bankDetails: 'Example Bank, 1234567890',
        paymentTermsDays: 14,
      }),
    );

    // Two units, inside the allowance, so the overage line does not confuse
    // what the plan line proves.
    await as(org.adminUserId, (tx) => createStandaloneHouse(
      tx, org.organisationId, org.adminUserId, {
        name: 'Priced House', code: 'PRC', propertyType: 'house',
        addressLine1: '4 Price Road', city: 'Cape Town',
      },
    ));
  });

  afterAll(async () => {
    // Order matters: a subscription references the plan, and the keep-one
    // trigger refuses deleting its prices directly — so move the customer off
    // it first and let the cascade take the prices with the plan.
    await ownerSql()`
      update subscriptions set plan_key = 'portfolio'
       where organisation_id = ${org.organisationId}
    `;
    await ownerSql()`delete from subscription_invoices where plan_key = ${planKey}`;
    await ownerSql()`delete from plans where key = ${planKey}`;
    await closeOwner();
  });

  it('bills a period at the price in force for that period, not today', async () => {
    // The rise: from 1 June, R1,299. Everything before that stays at R899.
    await asPlatformOperator(operator, (tx) =>
      setPlanPrice(tx, operator, {
        planKey, effectiveFrom: '2026-06-01',
        includedUnits: 10, monthlyPriceMinor: 129_900, additionalUnitPriceMinor: 5_000,
        reason: 'Price rise agreed for the new financial year.',
      }),
    );

    // May, invoiced late — the case the old code got wrong.
    const may = await asPlatformOperator(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-05-01', issueDate: '2026-06-02',
      }),
    );
    // If this customer was skipped, say WHY rather than asserting undefined:
    // the run names everybody it passed over and the reason is the fixture's
    // problem nine times out of ten.
    const mayInvoice = may.issued.find((i) => i.organisationName === 'Priced Co');
    expect(
      mayInvoice ?? may.skipped.find((sk) => sk.organisationName === 'Priced Co'),
    ).toBeDefined();
    expect(may.skipped.find((sk) => sk.organisationName === 'Priced Co')?.reason)
      .toBeUndefined();

    const [mayLine] = await ownerSql()<{ unit_price_minor: string }[]>`
      select l.unit_price_minor::text
        from subscription_invoice_lines l
        join subscription_invoices i on i.id = l.invoice_id
       where i.organisation_id = ${org.organisationId}
         and i.period_start = '2026-05-01' and l.kind = 'plan'
    `;
    expect(mayLine!.unit_price_minor).toBe('89900');

    // June, at June's price.
    await asPlatformOperator(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-06-01', issueDate: '2026-06-02',
      }),
    );
    const [juneLine] = await ownerSql()<{ unit_price_minor: string }[]>`
      select l.unit_price_minor::text
        from subscription_invoice_lines l
        join subscription_invoices i on i.id = l.invoice_id
       where i.organisation_id = ${org.organisationId}
         and i.period_start = '2026-06-01' and l.kind = 'plan'
    `;
    expect(juneLine!.unit_price_minor).toBe('129900');
  });

  it('names a customer whose plan had no price for the period, rather than dropping them', async () => {
    const fresh = `late_${Date.now().toString(36)}`;
    await asPlatformOperator(operator, (tx) =>
      createPlan(tx, operator, {
        key: fresh, name: 'Priced from today', currencyCode: 'ZAR',
        includedUnits: 5, monthlyPriceMinor: 50_000, additionalUnitPriceMinor: 1_000,
        reason: 'A plan whose first price starts today.',
      }),
    );
    const late = await createOrganisation('Late Priced Co');
    await ownerSql()`
      update subscriptions set plan_key = ${fresh}, status = 'active'
       where organisation_id = ${late.organisationId}
    `;
    await ownerSql()`
      update organisations set status = 'active' where id = ${late.organisationId}
    `;

    const run = await asPlatformOperator(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-04-01', issueDate: '2026-05-02',
      }),
    );
    const skipped = run.skipped.find((sk) => sk.organisationName === 'Late Priced Co');
    expect(skipped?.reason).toContain('no price in force');
    expect(run.issued.some((i) => i.organisationName === 'Late Priced Co')).toBe(false);

    await ownerSql()`
      update subscriptions set plan_key = 'portfolio'
       where organisation_id = ${late.organisationId}
    `;
    await ownerSql()`delete from plans where key = ${fresh}`;
  });

  it('refuses to reprice a period that has already been invoiced', async () => {
    // May and June are invoiced above. A price from 1 May would make those
    // invoices disagree with the price list for ever, and an issued invoice is
    // never rewritten.
    await expect(
      asPlatformOperator(operator, (tx) =>
        setPlanPrice(tx, operator, {
          planKey, effectiveFrom: '2026-05-01',
          includedUnits: 10, monthlyPriceMinor: 50_000, additionalUnitPriceMinor: 5_000,
          reason: 'Trying to change a period that is already billed.',
        }),
      ),
    ).rejects.toThrow(/already been invoiced/);

    // And the same applies to removing one.
    await expect(
      asPlatformOperator(operator, (tx) =>
        removePlanPrice(tx, operator, {
          planKey, effectiveFrom: '2026-06-01',
          reason: 'Trying to remove a price that has been billed.',
        }),
      ),
    ).rejects.toThrow(/already been invoiced/);
  });

  it('schedules a future price, which can still be changed or dropped', async () => {
    const nextYear = `${new Date().getFullYear() + 1}-07-01`;
    await asPlatformOperator(operator, (tx) =>
      setPlanPrice(tx, operator, {
        planKey, effectiveFrom: nextYear,
        includedUnits: 15, monthlyPriceMinor: 149_900, additionalUnitPriceMinor: 4_500,
        reason: 'Agreed at the pricing review.',
      }),
    );

    const [catalogued] = (await asPlatformOperator(operator, (tx) =>
      planCatalogue(tx, operator),
    )).filter((p) => p.key === planKey);
    const scheduled = catalogued!.prices.find((p) => p.effectiveFrom === nextYear)!;
    expect(scheduled.scheduled).toBe(true);
    expect(scheduled.inForce).toBe(false);
    expect(scheduled.monthlyPriceMinor).toBe(149_900);
    // Exactly one price is in force, and it is not the scheduled one.
    expect(catalogued!.prices.filter((p) => p.inForce)).toHaveLength(1);

    // Nothing is invoiced for that period yet, so it is still editable.
    await asPlatformOperator(operator, (tx) =>
      removePlanPrice(tx, operator, {
        planKey, effectiveFrom: nextYear, reason: 'Review postponed.',
      }),
    );
    const after = (await asPlatformOperator(operator, (tx) => planCatalogue(tx, operator)))
      .find((p) => p.key === planKey)!;
    expect(after.prices.some((p) => p.effectiveFrom === nextYear)).toBe(false);
  });

  it('will not leave a plan with no price at all', async () => {
    const lonely = `solo_${Date.now().toString(36)}`;
    await asPlatformOperator(operator, (tx) =>
      createPlan(tx, operator, {
        key: lonely, name: 'Only price', currencyCode: 'ZAR',
        includedUnits: 1, monthlyPriceMinor: 10_000, additionalUnitPriceMinor: 0,
        reason: 'A plan with exactly one price.',
      }),
    );

    const [only] = await ownerSql()<{ effective_from: string }[]>`
      select effective_from::text from plan_prices where plan_key = ${lonely}
    `;
    // A plan somebody can be put on, with no price, bills them nothing and
    // nobody notices until the month end.
    await expect(
      asPlatformOperator(operator, (tx) =>
        removePlanPrice(tx, operator, {
          planKey: lonely, effectiveFrom: only!.effective_from,
          reason: 'Trying to leave it priceless.',
        }),
      ),
    ).rejects.toThrow(/cannot exist with no price/);

    await ownerSql()`delete from plans where key = ${lonely}`;
  });

  it('retires a plan from the list without moving anybody off it', async () => {
    await asPlatformOperator(operator, (tx) =>
      setPlanActive(tx, operator, {
        key: planKey, isActive: false, reason: 'Replaced by the new tier.',
      }),
    );

    // Gone from what a customer can be put on.
    const offered = await as(org.adminUserId, (tx) => listPlans(tx));
    expect(offered.some((p) => p.key === planKey)).toBe(false);

    // Still billing the customer who is on it, at its own price.
    const [subscription] = await ownerSql()<{ plan_key: string }[]>`
      select plan_key from subscriptions where organisation_id = ${org.organisationId}
    `;
    expect(subscription!.plan_key).toBe(planKey);
    const july = await asPlatformOperator(operator, (tx) =>
      runSubscriptionBilling(tx, operator, {
        periodStart: '2026-07-01', issueDate: '2026-08-02',
      }),
    );
    expect(july.issued.some((i) => i.organisationName === 'Priced Co')).toBe(true);

    // And the record says so, because "did that move anybody?" is the question
    // somebody asks straight afterwards.
    const [audit] = await ownerSql()<{ after_state: { customersStillOnIt: number } }[]>`
      select after_state from audit_events
       where action = 'platform.plan_retired' order by occurred_at desc limit 1
    `;
    expect(audit!.after_state.customersStillOnIt).toBeGreaterThan(0);

    await asPlatformOperator(operator, (tx) =>
      setPlanActive(tx, operator, {
        key: planKey, isActive: true, reason: 'Back on the list for the rest of the tests.',
      }),
    );
  });

  it('sets an allowance that is not about money, and removing it means no limit', async () => {
    await asPlatformOperator(operator, (tx) =>
      setPlanEntitlement(tx, operator, {
        key: planKey, feature: 'staff_accounts', limitValue: 3,
        reason: 'Three seats on this tier.',
      }),
    );
    let catalogue = (await asPlatformOperator(operator, (tx) => planCatalogue(tx, operator)))
      .find((p) => p.key === planKey)!;
    expect(catalogue.entitlements.find((e) => e.feature === 'staff_accounts')?.limitValue)
      .toBe(3);

    await asPlatformOperator(operator, (tx) =>
      setPlanEntitlement(tx, operator, {
        key: planKey, feature: 'staff_accounts', limitValue: null,
        reason: 'Unlimited seats on this tier after all.',
      }),
    );
    catalogue = (await asPlatformOperator(operator, (tx) => planCatalogue(tx, operator)))
      .find((p) => p.key === planKey)!;
    // No row means no limit, which is how the entitlement check reads it.
    expect(catalogue.entitlements.some((e) => e.feature === 'staff_accounts')).toBe(false);
  });

  it('says what the price list is worth, so nobody has to use a spreadsheet', async () => {
    const revenue = await asPlatformOperator(operator, (tx) =>
      planRevenueAt(tx, operator, new Date().toISOString().slice(0, 10)),
    );
    const mine = revenue.find((r) => r.planKey === planKey)!;
    expect(mine.customers).toBeGreaterThan(0);
    expect(mine.monthlyMinor).toBeGreaterThan(0);
    expect(mine.currencyCode).toBe('ZAR');
  });

  it('keeps the price list to operators who hold the billing permission', async () => {
    const support = await createOperator('Spike Support Pricing', ['platform_support']);
    await expect(
      asPlatformOperator(support, (tx) =>
        setPlanPrice(tx, support, {
          planKey, effectiveFrom: '2030-01-01',
          includedUnits: 1, monthlyPriceMinor: 1, additionalUnitPriceMinor: 0,
          reason: 'Support should not price the product.',
        }),
      ),
    ).rejects.toThrow(/platform role does not include this/i);

    // And the table refuses it on the ordinary connection too. An UPDATE whose
    // policy fails affects no rows and does not raise, so the assertion is on
    // the name afterwards — the same shape as the operator-role tests.
    await as(support, (tx) => tx`
      update plans set name = 'Renamed by support' where key = ${planKey}
    `);
    const [unchanged] = await ownerSql()<{ name: string }[]>`
      select name from plans where key = ${planKey}
    `;
    expect(unchanged!.name).not.toBe('Renamed by support');

    // Reading stays open: a price list is not a secret, and the operator
    // answering "why were they charged that?" needs the history most.
    const readable = await asPlatformOperator(support, (tx) => planCatalogue(tx, support));
    expect(readable.length).toBeGreaterThan(0);
  });
});
