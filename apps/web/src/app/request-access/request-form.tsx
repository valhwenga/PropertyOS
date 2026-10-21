'use client';

import { useActionState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { requestAccessAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function RequestForm() {
  const [state, action, pending] = useActionState(requestAccessAction, null);

  if (state?.ok) {
    return (
      <Card className="p-5">
        <p className="text-sm font-medium text-ink-900">Thank you — we have your request</p>
        <p className="mt-1 text-sm text-ink-700">
          Someone at Spike will read it and, if it is a fit, set the account up and get the
          invitation link to the person you named. Nothing is charged and no account exists yet.
        </p>
        <p className="mt-2 text-sm text-ink-500">
          Sending it again will not make it faster: we already have it.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        {state && !state.ok ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.message}</p>
          </div>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="organisationName">What your business is called</label>
          <input
            id="organisationName" name="organisationName" required maxLength={200}
            autoComplete="organization" className={`mt-1 ${FIELD}`}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="contactName">Who will administer it</label>
            <input
              id="contactName" name="contactName" required maxLength={160}
              autoComplete="name" className={`mt-1 ${FIELD}`}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="contactEmail">Their email address</label>
            <input
              id="contactEmail" name="contactEmail" type="email" required maxLength={254}
              autoComplete="email" className={`mt-1 ${FIELD}`}
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-ink-500">
          The invitation goes to this address, so it has to be one they can open.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="contactPhone">Phone <span className="font-normal text-ink-400">optional</span></label>
            <input
              id="contactPhone" name="contactPhone" maxLength={40}
              autoComplete="tel" className={`mt-1 ${FIELD}`}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="portfolioSize">How many units you manage</label>
            <input
              id="portfolioSize" name="portfolioSize" type="number" min={0} max={1000000}
              inputMode="numeric" className={`mt-1 ${FIELD}`}
            />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="note">
            Anything else we should know <span className="font-normal text-ink-400">optional</span>
          </label>
          <textarea id="note" name="note" rows={3} maxLength={2000} className={`mt-1 ${FIELD}`} />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Sending…' : 'Send the request'}
        </Button>
        <p className="text-xs text-ink-500">
          We use these details to set up and contact you about the account, and for nothing else.
        </p>
      </form>
    </Card>
  );
}
