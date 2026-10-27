'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import {
  createPlanAction, removePlanPriceAction, setPlanActiveAction,
  setPlanEntitlementAction, setPlanPriceAction,
} from './actions';

/**
 * A plan, its price history, and what it will cost next.
 *
 * The history is shown rather than only the current price, because the
 * question an operator opens this page with is usually "what were they
 * charged in March and why", and a screen that shows one number cannot answer
 * it. A price in force, a price scheduled and a price that has passed are
 * three visibly different things.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export interface PriceView {
  effectiveFrom: string;
  includedUnits: number;
  /** For reading: formatted money, with separators. */
  monthlyPriceDisplay: string;
  additionalUnitPriceDisplay: string;
  /** For typing back in: the plain value a number field accepts. */
  monthlyPrice: string;
  additionalUnitPrice: string;
  reason: string;
  setByName: string | null;
  inForce: boolean;
  scheduled: boolean;
}

export interface PlanView {
  key: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  customers: number;
  prices: PriceView[];
  entitlements: Array<{ feature: string; limitValue: number | null }>;
}

export function PlanCard({
  plan, canManage, today,
}: { plan: PlanView; canManage: boolean; today: string }) {
  const [priced, price, pricing] = useActionState(setPlanPriceAction, null);
  const [removed, remove, removing] = useActionState(removePlanPriceAction, null);
  const [toggled, toggle, toggling] = useActionState(setPlanActiveAction, null);
  const [limited, limit, limiting] = useActionState(setPlanEntitlementAction, null);
  const [open, setOpen] = useState<'price' | 'retire' | 'limits' | null>(null);

  const current = plan.prices.find((p) => p.inForce);

  return (
    <Card className="p-5" data-plan={plan.key}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink-900">
            {plan.name}{' '}
            <span className="tabular text-xs text-ink-400">{plan.key}</span>
          </p>
          <p className="text-sm text-ink-700">
            {current
              ? `${current.monthlyPriceDisplay} a month · ${current.includedUnits} units included · ${current.additionalUnitPriceDisplay} each over that`
              : 'No price in force — nobody on this plan can be invoiced.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={plan.isActive ? 'positive' : 'neutral'} glyph={plan.isActive ? '●' : '■'}>
            {plan.isActive ? 'offered' : 'retired'}
          </StatusBadge>
          <StatusBadge tone="info" glyph="▣">
            {plan.customers} customer{plan.customers === 1 ? '' : 's'}
          </StatusBadge>
        </div>
      </div>

      {/* The four actions on this card share one place to show a refusal.
          Narrowed inside the map, the way every other form here does it. */}
      {[priced, removed, toggled, limited].map((outcome, index) =>
        outcome && !outcome.ok ? (
          <div
            key={index}
            className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2"
          >
            <p className="text-sm text-critical-700">{outcome.message}</p>
          </div>
        ) : null)}

      <ul className="mt-3 divide-y divide-ink-100 border-t border-ink-100">
        {plan.prices.map((p) => (
          <li key={p.effectiveFrom} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
            <div>
              <p className="text-sm text-ink-900">
                <span className="tabular">{p.effectiveFrom}</span>{' '}
                — {p.monthlyPriceDisplay}, {p.includedUnits} units included,{' '}
                {p.additionalUnitPriceDisplay} each over
              </p>
              <p className="text-xs text-ink-500">
                {p.reason}{p.setByName ? ` · ${p.setByName}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {p.inForce ? (
                <StatusBadge tone="positive" glyph="●">in force</StatusBadge>
              ) : p.scheduled ? (
                <StatusBadge tone="caution" glyph="◷">scheduled</StatusBadge>
              ) : (
                <span className="text-xs text-ink-400">past</span>
              )}
              {canManage && p.scheduled ? (
                <form action={remove} className="flex items-center gap-1.5">
                  <input type="hidden" name="planKey" value={plan.key} />
                  <input type="hidden" name="effectiveFrom" value={p.effectiveFrom} />
                  <input
                    name="reason" required minLength={5} placeholder="why it is dropped"
                    className="w-44 rounded-lg border border-ink-200 px-2 py-1 text-xs"
                  />
                  <Button type="submit" disabled={removing}>
                    {removing ? '…' : 'Drop'}
                  </Button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {plan.entitlements.length > 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          Also capped:{' '}
          {plan.entitlements.map((e) => `${e.feature} ${e.limitValue ?? 'unlimited'}`).join(' · ')}
        </p>
      ) : (
        <p className="mt-2 text-xs text-ink-500">
          No staff or storage cap — only the unit allowance above.
        </p>
      )}

      {canManage ? (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-ink-100 pt-3">
          <button
            type="button" onClick={() => setOpen(open === 'price' ? null : 'price')}
            className="text-sm font-medium text-spike-600 hover:underline"
          >
            {open === 'price' ? 'Cancel' : 'Set a price'}
          </button>
          <button
            type="button" onClick={() => setOpen(open === 'limits' ? null : 'limits')}
            className="text-sm font-medium text-spike-600 hover:underline"
          >
            {open === 'limits' ? 'Cancel' : 'Staff and storage caps'}
          </button>
          <button
            type="button" onClick={() => setOpen(open === 'retire' ? null : 'retire')}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {open === 'retire' ? 'Cancel' : plan.isActive ? 'Retire it' : 'Offer it again'}
          </button>
        </div>
      ) : null}

      {open === 'price' ? (
        <form action={price} className="mt-3 space-y-3 border-t border-ink-100 pt-3">
          <input type="hidden" name="planKey" value={plan.key} />
          <input type="hidden" name="currencyCode" value={plan.currencyCode} />
          <p className="text-xs text-ink-500">
            A price starts on a date and runs until the next one. A period that has already
            been invoiced cannot be repriced — issued invoices are never rewritten.
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className={LABEL} htmlFor={`from-${plan.key}`}>From</label>
              <input
                id={`from-${plan.key}`} name="effectiveFrom" type="date" required
                defaultValue={today} className={`mt-1 ${FIELD}`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`monthly-${plan.key}`}>
                Monthly ({plan.currencyCode})
              </label>
              <input
                id={`monthly-${plan.key}`} name="monthlyPrice" required inputMode="decimal"
                defaultValue={current?.monthlyPrice ?? ''} className={`mt-1 ${FIELD}`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`units-${plan.key}`}>Units included</label>
              <input
                id={`units-${plan.key}`} name="includedUnits" type="number" min={0} required
                defaultValue={current?.includedUnits ?? 0} className={`mt-1 ${FIELD}`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`over-${plan.key}`}>
                Each unit over ({plan.currencyCode})
              </label>
              <input
                id={`over-${plan.key}`} name="additionalUnitPrice" required inputMode="decimal"
                defaultValue={current?.additionalUnitPrice ?? '0.00'}
                className={`mt-1 ${FIELD}`}
              />
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor={`why-${plan.key}`}>Why</label>
            <input
              id={`why-${plan.key}`} name="reason" required minLength={5} maxLength={500}
              placeholder="Price rise agreed for the new financial year"
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <Button type="submit" variant="primary" disabled={pricing}>
            {pricing ? 'Saving…' : 'Save this price'}
          </Button>
        </form>
      ) : null}

      {open === 'limits' ? (
        <form action={limit} className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
          <input type="hidden" name="key" value={plan.key} />
          <div>
            <label className={LABEL} htmlFor={`feature-${plan.key}`}>Cap</label>
            <select id={`feature-${plan.key}`} name="feature" className={`mt-1 ${FIELD}`}>
              <option value="staff_accounts">Staff accounts</option>
              <option value="documents_gb">Document storage (GB)</option>
            </select>
          </div>
          <div className="w-32">
            <label className={LABEL} htmlFor={`limit-${plan.key}`}>Limit</label>
            <input
              id={`limit-${plan.key}`} name="limitValue" type="number" min={0}
              placeholder="blank = none" className={`mt-1 ${FIELD}`}
            />
          </div>
          <div className="min-w-52 flex-1">
            <label className={LABEL} htmlFor={`limitwhy-${plan.key}`}>Why</label>
            <input
              id={`limitwhy-${plan.key}`} name="reason" required minLength={5}
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <Button type="submit" disabled={limiting}>{limiting ? 'Saving…' : 'Save'}</Button>
        </form>
      ) : null}

      {open === 'retire' ? (
        <form action={toggle} className="mt-3 space-y-2 border-t border-ink-100 pt-3">
          <input type="hidden" name="key" value={plan.key} />
          <input type="hidden" name="isActive" value={plan.isActive ? 'false' : 'true'} />
          <p className="text-sm text-ink-700">
            {plan.isActive
              ? `Retiring takes it off the list a customer can be put on. The ${plan.customers} already on it stay on it and keep being billed at this price.`
              : 'Offering it again puts it back on the provisioning and plan-change forms.'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-60 flex-1">
              <label className={LABEL} htmlFor={`retirewhy-${plan.key}`}>Why</label>
              <input
                id={`retirewhy-${plan.key}`} name="reason" required minLength={5}
                className={`mt-1 ${FIELD}`}
              />
            </div>
            <Button type="submit" variant={plan.isActive ? 'danger' : 'primary'} disabled={toggling}>
              {toggling ? 'Saving…' : plan.isActive ? 'Retire it' : 'Offer it again'}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

export function NewPlanForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState(createPlanAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button" onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
      >
        Add a plan
      </button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-900">A new plan</h2>
        <p className="text-xs text-ink-500">
          It is created with its first price, starting today ({today}). A plan with no price
          is one somebody can be put on that bills them nothing.
        </p>

        {state && !state.ok ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.message}</p>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="new-key">Key</label>
            <input
              id="new-key" name="key" required pattern="[a-z][a-z0-9_]{1,38}[a-z0-9]"
              placeholder="enterprise" className={`mt-1 ${FIELD} font-mono`}
            />
            <p className="mt-1 text-xs text-ink-500">
              Lower case, and stored on every invoice — it cannot be changed afterwards.
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="new-name">Name customers read</label>
            <input id="new-name" name="name" required maxLength={80} className={`mt-1 ${FIELD}`} />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className={LABEL} htmlFor="new-currency">Currency</label>
            <input
              id="new-currency" name="currencyCode" defaultValue="ZAR" maxLength={3}
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="new-monthly">Monthly</label>
            <input id="new-monthly" name="monthlyPrice" required inputMode="decimal" className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="new-units">Units included</label>
            <input id="new-units" name="includedUnits" type="number" min={0} required className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="new-over">Each unit over</label>
            <input
              id="new-over" name="additionalUnitPrice" required inputMode="decimal"
              defaultValue="0.00" className={`mt-1 ${FIELD}`}
            />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="new-why">What this plan is for</label>
          <input id="new-why" name="reason" required minLength={5} maxLength={500} className={`mt-1 ${FIELD}`} />
        </div>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create the plan'}
          </Button>
          <button
            type="button" onClick={() => setOpen(false)}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
