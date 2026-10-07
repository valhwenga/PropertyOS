'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button, Card, EmptyState, ErrorState } from '@propertyos/ui';
import { FieldErrors } from '@/components/field-errors';
import { DateField } from '@/components/date-field';
import { draftLeaseAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function LeaseForm({
  org, currencyCode, units, residents,
}: {
  org: string;
  currencyCode: string;
  units: Array<{ unit_id: string; label: string; advertised_rent_minor: string | null }>;
  residents: Array<{ resident_id: string; name: string }>;
}) {
  const [state, action, pending] = useActionState(draftLeaseAction, null);

  // Nothing to lease, or nobody to lease to. Saying which is missing is more
  // use than an empty dropdown that refuses to submit.
  if (units.length === 0 || residents.length === 0) {
    return (
      <EmptyState
        title={units.length === 0 ? 'No vacant unit to lease' : 'No resident to lease to'}
        description={
          units.length === 0
            ? 'Every active unit already has a lease in force. Add a property, or end an existing lease first.'
            : 'A lease needs a resident. Add the person first, then come back.'
        }
        action={
          <Link
            href={units.length === 0 ? `/app/${org}/portfolio/new` : `/app/${org}/residents/new`}
            className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
          >
            {units.length === 0 ? 'Add a property' : 'Add a resident'}
          </Link>
        }
      />
    );
  }

  if (state?.ok) {
    return (
      <Card className="p-5">
        <p className="text-sm font-medium text-ink-900">Lease {state.reference} drafted</p>
        <p className="mt-1 text-sm text-ink-500">
          It is a draft: nothing has been charged and the unit is not reserved. Activate it from the
          lease when you are ready to bill.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/app/${org}/leases/${state.leaseId}`}
                className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Open the lease
          </Link>
          <Link href={`/app/${org}/leases`}
                className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700">
            Back to leases
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />

        {state && !state.ok ? (
          <div>
            <ErrorState title="Could not draft this lease" detail={state.message}
                        correlationId={state.correlationId} />
            <FieldErrors errors={state.fieldErrors} />
          </div>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="unitId">Unit</label>
          <select id="unitId" name="unitId" required className={`mt-1 ${FIELD}`}>
            {units.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-500">Units with a lease already in force are not listed.</p>
        </div>

        <div>
          <label className={LABEL} htmlFor="residentId">Primary resident</label>
          <select id="residentId" name="residentId" required className={`mt-1 ${FIELD}`}>
            {residents.map((r) => <option key={r.resident_id} value={r.resident_id}>{r.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            Co-lessees and guarantors can be added to the lease afterwards.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* DateField renders its own label and takes dd/mm/yyyy regardless of
              the browser's locale, which a native date input does not. */}
          <DateField name="startDate" label="Starts" required />
          <DateField name="endDate" label="Ends" hint="Leave blank for a month-to-month lease." />
          <div>
            <label className={LABEL} htmlFor="rent">Monthly rent ({currencyCode})</label>
            <input id="rent" name="rent" required inputMode="decimal" className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="depositRequired">Deposit required ({currencyCode})</label>
            <input id="depositRequired" name="depositRequired" inputMode="decimal" className={`mt-1 ${FIELD}`} />
            <p className="mt-1 text-xs text-ink-500">Held as a liability. It never offsets the rent.</p>
          </div>
          <div>
            <label className={LABEL} htmlFor="billingDay">Rent due on day</label>
            <input id="billingDay" name="billingDay" type="number" min={1} max={31} defaultValue={1}
                   className={`mt-1 ${FIELD}`} />
            <p className="mt-1 text-xs text-ink-500">A day past the month&rsquo;s end falls back to its last day.</p>
          </div>
          <div>
            <label className={LABEL} htmlFor="noticeDays">Notice to end (days)</label>
            <input id="noticeDays" name="noticeDays" type="number" min={0} max={365}
                   className={`mt-1 ${FIELD}`} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Drafting…' : 'Draft lease'}
          </Button>
          <Link href={`/app/${org}/leases`} className="text-sm text-ink-500 hover:underline">
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}
