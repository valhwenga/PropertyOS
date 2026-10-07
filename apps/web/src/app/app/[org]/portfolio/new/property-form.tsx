'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { FieldErrors } from '@/components/field-errors';
import { createPropertyAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

const TYPES = [
  ['house', 'House'],
  ['cottage', 'Cottage'],
  ['townhouse', 'Townhouse'],
  ['apartment', 'Apartment'],
  ['apartment_block', 'Apartment block (several units)'],
  ['other', 'Other'],
] as const;

export function PropertyForm({ org, currencyCode }: { org: string; currencyCode: string }) {
  const [state, action, pending] = useActionState(createPropertyAction, null);
  const [type, setType] = useState<string>('house');
  const isBlock = type === 'apartment_block';

  if (state?.ok) {
    return (
      <Card className="p-5">
        <p className="text-sm font-medium text-ink-900">Property added</p>
        <p className="mt-1 text-sm text-ink-500">
          {state.unitCreated
            ? 'It was created with one rentable unit, so you can draft a lease against it straight away.'
            : 'A block has no unit yet. Add its units before any of them can be let.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/app/${org}/portfolio`}
                className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Back to the portfolio
          </Link>
          {state.unitCreated ? (
            <Link href={`/app/${org}/leases/new`}
                  className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700">
              Draft a lease
            </Link>
          ) : null}
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
            <ErrorState title="Could not add this property" detail={state.message}
                        correlationId={state.correlationId} />
            <FieldErrors errors={state.fieldErrors} />
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="name">Property name</label>
            <input id="name" name="name" required maxLength={200} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="code">Short code</label>
            <input id="code" name="code" required maxLength={24} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,23}"
                   className={`mt-1 ${FIELD}`} />
            <p className="mt-1 text-xs text-ink-500">
              Your own reference, used on statements. Letters, numbers, dot, dash or underscore.
            </p>
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="propertyType">Type</label>
          <select id="propertyType" name="propertyType" value={type} onChange={(e) => setType(e.target.value)}
                  className={`mt-1 ${FIELD}`}>
            {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            {isBlock
              ? 'A block is created on its own. Its units are described separately, because they differ.'
              : 'Created with one rentable unit, so it can be let immediately.'}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="addressLine1">Street address</label>
            <input id="addressLine1" name="addressLine1" required maxLength={200} className={`mt-1 ${FIELD}`} />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="addressLine2">Address line 2</label>
            <input id="addressLine2" name="addressLine2" maxLength={200} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="suburb">Suburb</label>
            <input id="suburb" name="suburb" maxLength={120} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="city">City</label>
            <input id="city" name="city" required maxLength={120} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="province">Province</label>
            <input id="province" name="province" maxLength={120} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="postalCode">Postal code</label>
            <input id="postalCode" name="postalCode" maxLength={20} className={`mt-1 ${FIELD}`} />
          </div>
        </div>

        {!isBlock ? (
          <div>
            <label className={LABEL} htmlFor="advertisedRent">Advertised rent ({currencyCode})</label>
            <input id="advertisedRent" name="advertisedRent" inputMode="decimal" className={`mt-1 ${FIELD}`} />
            <p className="mt-1 text-xs text-ink-500">
              Optional, and only what you advertise. The rent that gets billed is set on the lease.
            </p>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Adding…' : 'Add property'}
          </Button>
          <Link href={`/app/${org}/portfolio`} className="text-sm text-ink-500 hover:underline">
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}
