import { Card, PageHeader } from '@propertyos/ui';
import {
  formatMoney, minorToMajorInput, planCatalogue, planRevenueAt, platformPermissionsOf,
} from '@propertyos/domain';
import { readPrivilegedAs, requireViewer } from '@/lib/auth';
import { NewPlanForm, PlanCard } from './plan-forms';

export const metadata = { title: 'Plans and pricing' };
export const dynamic = 'force-dynamic';

/**
 * What the product costs.
 *
 * `plans` carried a price from the first migration and nothing wrote to it, so
 * launching a tier or raising a price meant a deploy. The screen exists
 * because that made the commercial side of the business the one part of it an
 * engineer had to perform.
 *
 * Prices have dates. A billing run reads the price in force for the period it
 * is billing, not the price today, so invoicing March in April after a rise on
 * 1 April charges March at March's price — which is the bug this whole shape
 * exists to prevent.
 */
export default async function PlansPage() {
  const viewer = await requireViewer();
  const today = new Date().toISOString().slice(0, 10);

  const { plans, mine, revenue } = await readPrivilegedAs(viewer, async (tx) => {
    const held = await platformPermissionsOf(tx, viewer.authUserId);
    return {
      plans: await planCatalogue(tx, viewer.authUserId),
      mine: held,
      // Only for the operators who may price the product: it is the number
      // somebody would otherwise work out in a spreadsheet, and it is nobody
      // else's business.
      revenue: held.includes('platform.billing.manage')
        ? await planRevenueAt(tx, viewer.authUserId, today)
        : [],
    };
  });

  const canManage = mine.includes('platform.billing.manage');
  const totalByCurrency = revenue.reduce<Record<string, number>>((acc, r) => {
    acc[r.currencyCode] = (acc[r.currencyCode] ?? 0) + r.monthlyMinor;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans and pricing"
        description="What each plan costs, what it has cost, and what it will cost. A billing run uses the price in force for the period it bills — never the price today."
        actions={canManage ? <NewPlanForm today={today} /> : undefined}
      />

      {canManage ? null : (
        <Card className="border-info-700/25 bg-info-50 p-4">
          <p className="text-sm text-info-700">
            Your platform role does not include billing, so this page is read-only for you.
            The price history is here because &ldquo;why were they charged that?&rdquo; is a
            support question before it is a billing one.
          </p>
        </Card>
      )}

      {revenue.length > 0 ? (
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            What the price list is worth, at today&apos;s usage
          </p>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
            {Object.entries(totalByCurrency).map(([currency, total]) => (
              <p key={currency} className="tabular text-2xl font-semibold">
                {formatMoney(total, currency)}
                <span className="ml-1 text-sm font-normal text-ink-500">a month</span>
              </p>
            ))}
            {revenue.filter((r) => r.customers > 0).map((r) => (
              <p key={r.planKey} className="text-sm text-ink-600">
                <span className="font-medium text-ink-900">{r.planName}</span>{' '}
                {r.customers} customer{r.customers === 1 ? '' : 's'} ·{' '}
                <span className="tabular">{formatMoney(r.monthlyMinor, r.currencyCode)}</span>
              </p>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Plan fees plus overage at the units each customer has now. Trials are excluded, and
            nothing here is a forecast.
          </p>
        </Card>
      ) : null}

      <div className="space-y-4">
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            canManage={canManage}
            today={today}
            plan={{
              key: plan.key,
              name: plan.name,
              currencyCode: plan.currencyCode,
              isActive: plan.isActive,
              customers: plan.customers,
              entitlements: plan.entitlements,
              prices: plan.prices.map((p) => ({
                effectiveFrom: p.effectiveFrom,
                includedUnits: p.includedUnits,
                // Twice over, deliberately: formatted money to READ, because
                // R1,099.00 is a price and 1099.00 is a string; and the plain
                // value to TYPE BACK, because a field with a separator in it
                // is a field somebody has to clean up before editing.
                monthlyPriceDisplay: formatMoney(p.monthlyPriceMinor, plan.currencyCode),
                additionalUnitPriceDisplay: formatMoney(
                  p.additionalUnitPriceMinor, plan.currencyCode,
                ),
                monthlyPrice: minorToMajorInput(p.monthlyPriceMinor, plan.currencyCode),
                additionalUnitPrice: minorToMajorInput(
                  p.additionalUnitPriceMinor, plan.currencyCode,
                ),
                reason: p.reason,
                setByName: p.setByName,
                inForce: p.inForce,
                scheduled: p.scheduled,
              })),
            }}
          />
        ))}
      </div>
    </div>
  );
}
