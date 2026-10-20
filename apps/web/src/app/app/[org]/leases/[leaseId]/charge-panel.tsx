'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import type { ChargeCategory } from '@propertyos/domain';
import { raiseChargeAction } from './charge-actions';

/**
 * Billing this lease for something that is not the monthly rent.
 *
 * Built around the municipal recovery, because that is the charge a tenant
 * actually queries: water, electricity, sewerage — each one a reading times a
 * tariff, each one different every month. Choosing one of those categories
 * opens the meter fields and suggests the unit; choosing a refuse charge or a
 * levy does not, because there is no meter to read.
 *
 * The readings do not compute the amount. The operator types what the
 * municipality charged, and the readings are stored beside it so the invoice
 * can show the tenant where the figure came from. A form that quietly
 * multiplied two numbers into a total would be deciding what somebody owes
 * from values nobody checked.
 */
export function ChargePanel({
  org, leaseId, categories, today, currencySymbol,
}: {
  org: string;
  leaseId: string;
  categories: readonly ChargeCategory[];
  /** Today in the ORGANISATION's time zone, resolved on the server. */
  today: string;
  currencySymbol: string;
}) {
  const [state, action, pending] = useActionState(raiseChargeAction, null);
  const [category, setCategory] = useState(categories[1]?.key ?? 'utility_water');

  const chosen = categories.find((c) => c.key === category) ?? null;
  const posted = state?.ok
    ? (state as unknown as { documentNumber: string }).documentNumber
    : null;

  const field = `
    mt-1 block w-full rounded-[var(--radius-control)] border border-ink-200 bg-surface
    px-3 py-2 text-[length:var(--text-table)] text-ink-900
  `;
  const labelText = 'block text-[length:var(--text-meta)] font-medium text-ink-700';

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />

      {state && !state.ok ? (
        <ErrorState
          title="Not charged"
          detail={state.message ?? ''}
          correlationId={state.correlationId}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelText}>
          What is this for
          <select
            name="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className={field}
          >
            {categories.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className={labelText}>
          Amount ({currencySymbol})
          <input
            name="amount"
            inputMode="decimal"
            required
            placeholder="385.80"
            className={`${field} tabular`}
          />
        </label>

        <label className={`${labelText} sm:col-span-2`}>
          Description on the invoice
          <input
            name="description"
            maxLength={300}
            placeholder={chosen?.defaultDescription ?? ''}
            className={field}
          />
        </label>

        <label className={labelText}>
          Issued
          <input type="date" name="issueDate" defaultValue={today} required className={field} />
        </label>
        <label className={labelText}>
          Due
          <input type="date" name="dueDate" defaultValue={today} required className={field} />
        </label>

        <label className={labelText}>
          Period from
          <input type="date" name="periodStart" className={field} />
        </label>
        <label className={labelText}>
          Period to
          <input type="date" name="periodEnd" className={field} />
        </label>
      </div>

      {chosen?.measured ? (
        <fieldset className="rounded-[var(--radius-control)] border border-ink-200 p-3">
          <legend className="px-1 text-[length:var(--text-meta)] font-medium text-ink-700">
            The reading behind it (optional, and printed on the invoice)
          </legend>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className={labelText}>
              Previous reading
              <input name="meterPrevious" inputMode="decimal" className={`${field} tabular`} />
            </label>
            <label className={labelText}>
              Current reading
              <input name="meterCurrent" inputMode="decimal" className={`${field} tabular`} />
            </label>
            <label className={labelText}>
              Quantity
              <input name="quantity" inputMode="decimal" className={`${field} tabular`} />
            </label>
            <label className={labelText}>
              Rate per {chosen.unit ?? 'unit'}
              <input name="unitRate" inputMode="decimal" className={`${field} tabular`} />
            </label>
          </div>
          <input type="hidden" name="unit" value={chosen.unit ?? ''} />
          <p className="mt-2 text-[length:var(--text-meta)] text-ink-500">
            The quantity and rate are shown to the tenant as the sum behind the amount. They
            are not used to calculate it — the amount above is what gets charged, and the
            invoice says so if the two disagree.
          </p>
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Posting…' : 'Post this charge'}
        </Button>
        <span className="text-[length:var(--text-meta)] text-ink-500">
          It posts to the ledger immediately and cannot be edited afterwards; a mistake is
          corrected with a credit note.
        </span>
        {posted ? (
          <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
            Posted as {posted}.
          </span>
        ) : null}
      </div>
    </form>
  );
}
