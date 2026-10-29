'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import { captureChargeAction, discardCaptureAction } from './actions';

/**
 * The month, one lease at a time, without leaving the page.
 *
 * The old way was to open each lease, open its charges panel, type, post, go
 * back. Forty tenancies was forty round trips, and every posting was final the
 * moment it happened. Here the row stays put, what you type is a draft until
 * the run posts it, and the previous reading is already in the box — which is
 * the whole difference between reading a meter book and doing arithmetic.
 *
 * Metered categories show readings and a tariff; the rest show an amount. The
 * arithmetic is done again in the domain, because a number typed into a
 * browser is a suggestion.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-sm text-ink-900';

export interface CategoryOption {
  key: string;
  label: string;
  measured: boolean;
  unit: string | null;
}

export interface LeaseRow {
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  residentName: string | null;
  lastReadings: Record<string, { reading: number | null; at: string }>;
  /** What is already captured for this lease this month, for the summary. */
  captured: Array<{ id: string; categoryLabel: string; amount: string }>;
}

export function CaptureRow({
  org, periodStart, lease, categories,
}: {
  org: string;
  periodStart: string;
  lease: LeaseRow;
  categories: CategoryOption[];
}) {
  const [state, action, pending] = useActionState(captureChargeAction, null);
  const [category, setCategory] = useState(categories[0]?.key ?? 'utility_water');
  const definition = categories.find((c) => c.key === category);
  const previous = lease.lastReadings[category];

  return (
    <Card className="p-4" data-capture-lease={lease.leaseReference}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">{lease.unitLabel}</p>
          <p className="text-xs text-ink-500">
            {lease.residentName ?? 'No resident recorded'} · {lease.leaseReference}
          </p>
        </div>
        {lease.captured.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {lease.captured.map((c) => (
              <StatusBadge key={c.id} tone="info" glyph="◐">
                {c.categoryLabel} {c.amount}
              </StatusBadge>
            ))}
          </div>
        ) : null}
      </div>

      <form action={action} className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="periodStart" value={periodStart} />
        <input type="hidden" name="leaseId" value={lease.leaseId} />

        <div className="w-44">
          <label className="block text-xs font-medium text-ink-600" htmlFor={`cat-${lease.leaseId}`}>
            Charge
          </label>
          <select
            id={`cat-${lease.leaseId}`} name="category" value={category}
            onChange={(event) => setCategory(event.target.value)}
            className={`mt-1 ${FIELD}`}
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>

        {definition?.measured ? (
          <>
            <div className="w-28">
              <label className="block text-xs font-medium text-ink-600" htmlFor={`prev-${lease.leaseId}`}>
                Previous
              </label>
              <input
                id={`prev-${lease.leaseId}`} name="meterPrevious" inputMode="decimal"
                defaultValue={previous?.reading ?? ''}
                key={`${category}-${previous?.reading ?? ''}`}
                className={`mt-1 tabular ${FIELD}`}
              />
              {previous ? (
                <p className="mt-0.5 text-[11px] text-ink-400">read {previous.at.slice(0, 7)}</p>
              ) : null}
            </div>
            <div className="w-28">
              <label className="block text-xs font-medium text-ink-600" htmlFor={`curr-${lease.leaseId}`}>
                Current
              </label>
              <input
                id={`curr-${lease.leaseId}`} name="meterCurrent" inputMode="decimal"
                className={`mt-1 tabular ${FIELD}`}
              />
            </div>
            <div className="w-28">
              <label className="block text-xs font-medium text-ink-600" htmlFor={`rate-${lease.leaseId}`}>
                Rate per {definition.unit ?? 'unit'}
              </label>
              <input
                id={`rate-${lease.leaseId}`} name="unitRate" inputMode="decimal"
                placeholder="27.30" className={`mt-1 tabular ${FIELD}`}
              />
            </div>
          </>
        ) : (
          <div className="w-32">
            <label className="block text-xs font-medium text-ink-600" htmlFor={`amt-${lease.leaseId}`}>
              Amount
            </label>
            <input
              id={`amt-${lease.leaseId}`} name="amount" inputMode="decimal"
              placeholder="215.00" className={`mt-1 tabular ${FIELD}`}
            />
          </div>
        )}

        <div className="min-w-40 flex-1">
          <label className="block text-xs font-medium text-ink-600" htmlFor={`desc-${lease.leaseId}`}>
            Description <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <input
            id={`desc-${lease.leaseId}`} name="description" maxLength={200}
            placeholder={definition?.label} className={`mt-1 ${FIELD}`}
          />
        </div>

        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : 'Capture'}
        </Button>
      </form>

      {state && !state.ok ? (
        <p className="mt-2 text-sm text-critical-700">{state.message}</p>
      ) : null}
      {state?.ok ? (
        <p className="mt-2 text-sm text-positive-600">
          Captured. Nothing is billed until the run is posted.
        </p>
      ) : null}
    </Card>
  );
}

export function DiscardCapture({ org, pendingChargeId }: { org: string; pendingChargeId: string }) {
  const [state, action, pending] = useActionState(discardCaptureAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="pendingChargeId" value={pendingChargeId} />
      <button
        type="submit" disabled={pending}
        className="text-xs font-medium text-ink-500 hover:text-critical-700 hover:underline"
      >
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state && !state.ok ? (
        <span className="ml-2 text-xs text-critical-700">{state.message}</span>
      ) : null}
    </form>
  );
}
