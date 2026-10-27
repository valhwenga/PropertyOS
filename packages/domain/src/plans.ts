import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { conflict, invalid, notFound, parsed } from './errors';
import { recordAudit } from './audit';
import { requirePlatformOperator, requirePlatformPermission } from './platform';

/**
 * The price list.
 *
 * `plans` carried a price from the first migration and nothing ever wrote to
 * it: launching a tier, raising R899 or widening an allowance meant a
 * migration and a deploy, so the console could put a customer on a plan and
 * could not say what a plan costs.
 *
 * A price here has a DATE. The obvious version of this feature — editable
 * price columns — is wrong in a way the billing run exposes: it reads the
 * price at the moment it runs, so invoicing March in April after a rise on
 * 1 April would charge March at April's price. `plan_prices` is what a plan
 * has cost and will cost; the run asks for the price in force on the first day
 * of the period it is billing.
 *
 * See docs/decisions/0026-a-price-has-a-date.md.
 */

export interface PlanPriceRow {
  effectiveFrom: string;
  includedUnits: number;
  monthlyPriceMinor: number;
  additionalUnitPriceMinor: number;
  reason: string;
  setByName: string | null;
  /** The one a billing run would use for a period starting today. */
  inForce: boolean;
  /** Starts later: scheduled, and still changeable. */
  scheduled: boolean;
}

export interface PlanRowDetail {
  key: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  /** How many customers are on it now. A plan with customers cannot be retired. */
  customers: number;
  prices: PlanPriceRow[];
  entitlements: Array<{ feature: string; limitValue: number | null }>;
}

/**
 * Every plan, with its whole price history and what is scheduled.
 *
 * Readable by anybody in the console: a price list is not a secret — the
 * customer-facing `listPlans` has said so since it was written — and the
 * operator answering "why were they charged that?" needs the history more than
 * anybody.
 */
export async function planCatalogue(tx: Sql, authUserId: string): Promise<PlanRowDetail[]> {
  await requirePlatformOperator(tx, authUserId);

  const plans = await tx<Array<{
    key: string; name: string; currency_code: string; is_active: boolean; customers: string;
  }>>`
    select p.key, p.name, p.currency_code, p.is_active,
           (select count(*) from subscriptions s where s.plan_key = p.key)::text as customers
      from plans p
     order by p.is_active desc, p.key
  `;

  const prices = await tx<Array<{
    plan_key: string; effective_from: string; included_units: number;
    monthly_price_minor: string; additional_unit_price_minor: string;
    reason: string; set_by_name: string | null; in_force: boolean;
  }>>`
    select pp.plan_key, pp.effective_from::text, pp.included_units,
           pp.monthly_price_minor::text, pp.additional_unit_price_minor::text,
           pp.reason, by.full_name as set_by_name,
           (pp.effective_from = (
              select max(x.effective_from) from plan_prices x
               where x.plan_key = pp.plan_key and x.effective_from <= current_date
            )) as in_force
      from plan_prices pp
      left join user_profiles by on by.auth_user_id = pp.set_by
     order by pp.plan_key, pp.effective_from desc
  `;

  const entitlements = await tx<Array<{
    plan_key: string; feature: string; limit_value: number | null;
  }>>`
    select plan_key, feature, limit_value from plan_entitlements
     order by plan_key, feature
  `;

  const today = new Date().toISOString().slice(0, 10);
  return plans.map((p) => ({
    key: p.key,
    name: p.name,
    currencyCode: p.currency_code,
    isActive: p.is_active,
    customers: Number(p.customers),
    prices: prices.filter((pp) => pp.plan_key === p.key).map((pp) => ({
      effectiveFrom: pp.effective_from,
      includedUnits: pp.included_units,
      monthlyPriceMinor: Number(pp.monthly_price_minor),
      additionalUnitPriceMinor: Number(pp.additional_unit_price_minor),
      reason: pp.reason,
      setByName: pp.set_by_name,
      inForce: pp.in_force,
      scheduled: pp.effective_from > today,
    })),
    entitlements: entitlements.filter((e) => e.plan_key === p.key).map((e) => ({
      feature: e.feature, limitValue: e.limit_value,
    })),
  }));
}

const priceSchema = z.object({
  planKey: z.string().trim().regex(
    /^[a-z][a-z0-9_]{1,38}[a-z0-9]$/,
    'Use lower-case letters, numbers and underscores.',
  ),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.'),
  includedUnits: z.coerce.number().int().min(0).max(1_000_000),
  monthlyPriceMinor: z.coerce.number().int().min(0).max(100_000_000),
  additionalUnitPriceMinor: z.coerce.number().int().min(0).max(10_000_000),
  reason: z.string().trim()
    .min(5, 'Say why this price is changing, so the history reads.').max(500),
});

/**
 * Scheduling a price.
 *
 * The same call sets today's price and next quarter's: a price is a row with a
 * date, and "now" is just a date. The database refuses one over a period that
 * has already been invoiced and says which invoice, because an issued invoice
 * carries its own figures and is never rewritten — a price change across it
 * would leave the invoice and the price list disagreeing for ever.
 */
export async function setPlanPrice(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof priceSchema>,
): Promise<void> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const details = parsed(priceSchema, input);

  const [plan] = await tx<{ key: string; name: string }[]>`
    select key, name from plans where key = ${details.planKey}
  `;
  if (!plan) throw notFound('Plan');

  const [before] = await tx<{ monthly_price_minor: string }[]>`
    select monthly_price_minor::text from app.plan_price_at(
      ${details.planKey}, ${details.effectiveFrom}::date
    )
  `;

  await tx`
    insert into plan_prices (
      plan_key, effective_from, included_units, monthly_price_minor,
      additional_unit_price_minor, reason, set_by
    ) values (
      ${details.planKey}, ${details.effectiveFrom}::date, ${details.includedUnits},
      ${details.monthlyPriceMinor}, ${details.additionalUnitPriceMinor},
      ${details.reason}, ${authUserId}::uuid
    )
    on conflict (plan_key, effective_from) do update
      set included_units = excluded.included_units,
          monthly_price_minor = excluded.monthly_price_minor,
          additional_unit_price_minor = excluded.additional_unit_price_minor,
          reason = excluded.reason, set_by = excluded.set_by, set_at = now()
  `;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.plan_price_set',
    resourceType: 'plan',
    resourceId: null,
    reason: details.reason,
    before: { plan: plan.key, monthlyPriceMinor: before?.monthly_price_minor ?? null },
    after: {
      plan: plan.key,
      effectiveFrom: details.effectiveFrom,
      includedUnits: details.includedUnits,
      monthlyPriceMinor: details.monthlyPriceMinor,
      additionalUnitPriceMinor: details.additionalUnitPriceMinor,
      setBy: actor.fullName,
    },
  });
}

/** Dropping a price that has not started yet. */
export async function removePlanPrice(
  tx: Sql,
  authUserId: string,
  input: { planKey: string; effectiveFrom: string; reason: string },
): Promise<void> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const details = parsed(
    priceSchema.pick({ planKey: true, effectiveFrom: true, reason: true }),
    input,
  );

  const removed = await tx<{ monthly_price_minor: string }[]>`
    delete from plan_prices
     where plan_key = ${details.planKey} and effective_from = ${details.effectiveFrom}::date
     returning monthly_price_minor::text
  `;
  if (removed.length === 0) {
    throw conflict('There is no price for that plan from that date. Nothing was changed.');
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.plan_price_removed',
    resourceType: 'plan',
    resourceId: null,
    reason: details.reason,
    before: {
      plan: details.planKey,
      effectiveFrom: details.effectiveFrom,
      monthlyPriceMinor: removed[0]!.monthly_price_minor,
    },
  });
}

const planSchema = z.object({
  key: z.string().trim().regex(
    /^[a-z][a-z0-9_]{1,38}[a-z0-9]$/,
    'Use lower-case letters, numbers and underscores — it is stored on every invoice.',
  ),
  name: z.string().trim().min(2, 'Give the plan a name customers will read.').max(80),
  currencyCode: z.string().trim().length(3).toUpperCase().default('ZAR'),
  includedUnits: z.coerce.number().int().min(0).max(1_000_000),
  monthlyPriceMinor: z.coerce.number().int().min(0).max(100_000_000),
  additionalUnitPriceMinor: z.coerce.number().int().min(0).max(10_000_000),
  reason: z.string().trim().min(5, 'Say what this plan is for.').max(500),
});

/**
 * A new tier.
 *
 * Created with its first price in the same transaction, because a plan with no
 * price is one somebody can be put on that bills them nothing — and the
 * failure is silent until a month end. The schema enforces it too.
 */
export async function createPlan(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof planSchema>,
): Promise<void> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const details = parsed(planSchema, input);

  const [clash] = await tx<{ key: string }[]>`select key from plans where key = ${details.key}`;
  if (clash) throw conflict(`There is already a plan called "${details.key}".`);

  await tx`
    insert into plans (key, name, currency_code, is_active)
    values (${details.key}, ${details.name}, ${details.currencyCode}, true)
  `;
  await tx`
    insert into plan_prices (
      plan_key, effective_from, included_units, monthly_price_minor,
      additional_unit_price_minor, reason, set_by
    ) values (
      ${details.key}, current_date, ${details.includedUnits}, ${details.monthlyPriceMinor},
      ${details.additionalUnitPriceMinor}, ${details.reason}, ${authUserId}::uuid
    )
  `;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.plan_created',
    resourceType: 'plan',
    resourceId: null,
    reason: details.reason,
    after: {
      plan: details.key, name: details.name,
      monthlyPriceMinor: details.monthlyPriceMinor,
      includedUnits: details.includedUnits,
      createdBy: actor.fullName,
    },
  });
}

/**
 * Taking a plan off the list, or putting it back.
 *
 * Retiring does not touch the customers on it: their subscription keeps
 * working and keeps being billed at whatever that plan costs. It stops the
 * plan being OFFERED — on the provisioning form and on the plan-change form —
 * which is what retiring a tier means. A plan nobody is on and nobody can be
 * put on is still in the list, greyed, because its name is on old invoices.
 */
export async function setPlanActive(
  tx: Sql,
  authUserId: string,
  input: { key: string; isActive: boolean; reason: string },
): Promise<void> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const details = parsed(
    z.object({
      key: z.string().trim().min(2).max(40),
      isActive: z.boolean(),
      reason: z.string().trim().min(5, 'Say why.').max(500),
    }),
    input,
  );

  const [plan] = await tx<{ key: string; is_active: boolean; customers: string }[]>`
    select p.key, p.is_active,
           (select count(*) from subscriptions s where s.plan_key = p.key)::text as customers
      from plans p where p.key = ${details.key}
  `;
  if (!plan) throw notFound('Plan');
  if (plan.is_active === details.isActive) {
    throw conflict(
      details.isActive ? 'That plan is already offered.' : 'That plan is already retired.',
    );
  }

  await tx`update plans set is_active = ${details.isActive} where key = ${details.key}`;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: details.isActive ? 'platform.plan_offered' : 'platform.plan_retired',
    resourceType: 'plan',
    resourceId: null,
    reason: details.reason,
    after: {
      plan: details.key,
      offered: details.isActive,
      // Said in the record because it is the question somebody will ask
      // afterwards: retiring a plan does not move anybody off it.
      customersStillOnIt: Number(plan.customers),
    },
  });
}

/** An allowance that is not about money: staff accounts, document storage. */
export async function setPlanEntitlement(
  tx: Sql,
  authUserId: string,
  input: { key: string; feature: string; limitValue: number | null; reason: string },
): Promise<void> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  const details = parsed(
    z.object({
      key: z.string().trim().min(2).max(40),
      feature: z.enum(['staff_accounts', 'documents_gb']),
      limitValue: z.coerce.number().int().min(0).max(1_000_000).nullable(),
      reason: z.string().trim().min(5, 'Say why.').max(500),
    }),
    input,
  );

  const [plan] = await tx<{ key: string }[]>`select key from plans where key = ${details.key}`;
  if (!plan) throw notFound('Plan');

  const [before] = await tx<{ limit_value: number | null }[]>`
    select limit_value from plan_entitlements
     where plan_key = ${details.key} and feature = ${details.feature}
  `;

  if (details.limitValue === null) {
    // No row means no limit, which is how the entitlement check reads it.
    await tx`
      delete from plan_entitlements
       where plan_key = ${details.key} and feature = ${details.feature}
    `;
  } else {
    await tx`
      insert into plan_entitlements (plan_key, feature, limit_value)
      values (${details.key}, ${details.feature}, ${details.limitValue})
      on conflict (plan_key, feature) do update set limit_value = excluded.limit_value
    `;
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.plan_entitlement_set',
    resourceType: 'plan',
    resourceId: null,
    reason: details.reason,
    before: { plan: details.key, feature: details.feature, limit: before?.limit_value ?? null },
    after: {
      plan: details.key, feature: details.feature,
      limit: details.limitValue, meaning: details.limitValue === null ? 'no limit' : 'capped',
    },
  });
}

/**
 * What a customer would be charged for a period, at today's price list.
 *
 * For the screen that asks "what does this price change do to our revenue?" —
 * a question nobody could answer from the console before, and which a price
 * list without it invites somebody to answer in a spreadsheet instead.
 */
export async function planRevenueAt(
  tx: Sql,
  authUserId: string,
  onDate: string,
): Promise<Array<{
  planKey: string; planName: string; customers: number; monthlyMinor: number;
  currencyCode: string;
}>> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) throw invalid('Give the date as yyyy-mm-dd.');

  const rows = await tx<Array<{
    plan_key: string; plan_name: string; currency_code: string;
    customers: string; monthly_minor: string;
  }>>`
    select p.key as plan_key, p.name as plan_name, p.currency_code,
           count(s.organisation_id)::text as customers,
           coalesce(sum(
             price.monthly_price_minor
             + greatest(0, coalesce(u.billable_units, 0) - price.included_units)
               * price.additional_unit_price_minor
           ), 0)::text as monthly_minor
      from plans p
      cross join lateral app.plan_price_at(p.key, ${onDate}::date) price
      left join subscriptions s on s.plan_key = p.key and s.status <> 'trial'
      left join app.platform_customer_usage() u on u.organisation_id = s.organisation_id
     group by p.key, p.name, p.currency_code
     order by p.key
  `;
  return rows.map((r) => ({
    planKey: r.plan_key,
    planName: r.plan_name,
    currencyCode: r.currency_code,
    customers: Number(r.customers),
    monthlyMinor: Number(r.monthly_minor),
  }));
}
