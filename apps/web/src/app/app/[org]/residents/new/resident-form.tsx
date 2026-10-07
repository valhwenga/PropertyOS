'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { FieldErrors } from '@/components/field-errors';
import { createResidentAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function ResidentForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(createResidentAction, null);

  if (state?.ok) {
    return (
      <Card className="p-5">
        <p className="text-sm font-medium text-ink-900">Resident added</p>
        <p className="mt-1 text-sm text-ink-500">
          The profile exists. No portal account has been created — a resident is a person record,
          not a login.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/app/${org}/residents`}
                className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Back to residents
          </Link>
          <Link href={`/app/${org}/leases/new`}
                className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700">
            Draft their lease
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
            <ErrorState title="Could not add this resident" detail={state.message}
                        correlationId={state.correlationId} />
            <FieldErrors errors={state.fieldErrors} />
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="firstName">First name</label>
            <input id="firstName" name="firstName" required maxLength={100} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="lastName">Last name</label>
            <input id="lastName" name="lastName" required maxLength={100} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" className={`mt-1 ${FIELD}`} />
            <p className="mt-1 text-xs text-ink-500">Optional. Needed later to invite them to the portal.</p>
          </div>
          <div>
            <label className={LABEL} htmlFor="phone">Phone</label>
            <input id="phone" name="phone" maxLength={40} className={`mt-1 ${FIELD}`} />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="communicationPreference">How they prefer to be contacted</label>
          <select id="communicationPreference" name="communicationPreference" defaultValue="email"
                  className={`mt-1 ${FIELD}`}>
            <option value="email">Email</option>
            <option value="in_app">In the portal only</option>
            <option value="none">Do not contact</option>
          </select>
        </div>

        <div>
          <label className={LABEL} htmlFor="notes">Notes</label>
          <textarea id="notes" name="notes" rows={3} maxLength={2000} className={`mt-1 ${FIELD}`} />
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Adding…' : 'Add resident'}
          </Button>
          <Link href={`/app/${org}/residents`} className="text-sm text-ink-500 hover:underline">
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}
