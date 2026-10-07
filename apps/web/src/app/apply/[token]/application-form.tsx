'use client';

import { useActionState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { submitApplicationAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function ApplicationForm({
  token, organisationName,
}: { token: string; organisationName: string }) {
  const [state, action, pending] = useActionState(submitApplicationAction, null);

  if (state?.ok) {
    return (
      <Card className="p-5">
        <p className="text-sm font-medium text-ink-900">Application received</p>
        <p className="mt-1 text-sm text-ink-700">
          Your reference is <strong className="tabular">{state.reference}</strong>. Keep it: it is
          how {organisationName} will identify your application.
        </p>
        <p className="mt-2 text-sm text-ink-500">
          Submitting an application is not an offer and does not reserve anything. {organisationName}{' '}
          will contact you using the details you gave.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />

        {state && !state.ok ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.message}</p>
          </div>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="fullName">Your full name</label>
          <input id="fullName" name="fullName" required maxLength={160} className={`mt-1 ${FIELD}`} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="phone">Phone</label>
            <input id="phone" name="phone" maxLength={40} className={`mt-1 ${FIELD}`} />
          </div>
        </div>
        <p className="-mt-2 text-xs text-ink-500">Give at least one of these so you can be contacted.</p>

        <div>
          <label className={LABEL} htmlFor="currentAddress">Where you live now</label>
          <input id="currentAddress" name="currentAddress" maxLength={300} className={`mt-1 ${FIELD}`} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="employment">Employment</label>
            <input id="employment" name="employment" maxLength={300} className={`mt-1 ${FIELD}`}
                   placeholder="Employer, or self-employed" />
          </div>
          <div>
            <label className={LABEL} htmlFor="monthlyIncome">Monthly income (ZAR)</label>
            <input id="monthlyIncome" name="monthlyIncome" inputMode="decimal" className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="occupants">How many people will live there</label>
            <input id="occupants" name="occupants" type="number" min={1} max={30}
                   className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="moveInDate">Preferred move-in date</label>
            <input id="moveInDate" name="moveInDate" inputMode="numeric" placeholder="dd/mm/yyyy"
                   className={`mt-1 ${FIELD}`} />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="message">Anything else</label>
          <textarea id="message" name="message" rows={3} maxLength={2000} className={`mt-1 ${FIELD}`} />
        </div>

        <div className="rounded-lg border border-ink-100 bg-ink-50 px-3 py-2">
          <p className="text-xs text-ink-700">
            {organisationName} will use these details to consider your application and to contact
            you about it. Do not send an identity number or bank details through this form — they
            are not needed to apply, and will be asked for separately if your application proceeds.
          </p>
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Sending…' : 'Send application'}
        </Button>
      </form>
    </Card>
  );
}
