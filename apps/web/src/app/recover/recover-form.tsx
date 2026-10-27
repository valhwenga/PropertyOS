'use client';

import { useActionState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { requestRecoveryAction } from './actions';

/**
 * The form a locked-out person fills in.
 *
 * What it does NOT do is tell them anything back. The confirmation is the same
 * sentence whether the address has an account, has one with a request already
 * open, or has none at all — so somebody who types a list of addresses into it
 * learns nothing about which of them are customers.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export function RecoverForm() {
  const [state, action, pending] = useActionState(requestRecoveryAction, null);

  if (state?.ok) {
    return (
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-ink-900">Somebody will be in touch</h2>
        <p className="mt-2 text-sm text-ink-700">
          If that address has an account, whoever administers it has been asked to confirm
          it is you and to send you a link. If your organisation has nobody else who can,
          Spike support will handle it — and they will ring you before anything changes.
        </p>
        <p className="mt-2 text-sm text-ink-500">
          Nothing about your account has changed yet, and nobody can sign in as you in the
          meantime.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ink-700">
            The email address you sign in with
          </label>
          <input
            id="email" name="email" type="email" required autoComplete="username"
            className={`mt-1 ${FIELD}`}
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">What has happened</legend>
          {[
            ['password', 'I have forgotten my password', 'Your authenticator app still works.'],
            ['second_factor', 'I have lost my authenticator',
              'You know your password, but cannot produce a code.'],
            ['both', 'Both', 'A new phone and a password you cannot remember.'],
          ].map(([value, label, hint]) => (
            <label key={value} className="flex gap-3 rounded-lg border border-ink-200 p-3">
              <input
                type="radio" name="lost" value={value} required className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-ink-900">{label}</span>
                <span className="block text-xs text-ink-500">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div>
          <label htmlFor="note" className="block text-sm font-medium text-ink-700">
            Anything that would help them know it is you
          </label>
          <input
            id="note" name="note" maxLength={500}
            placeholder="New phone since Friday, same number"
            className={`mt-1 ${FIELD}`}
          />
          <p className="mt-1 text-xs text-ink-500">
            Read by whoever administers your account. Do not put a password or an ID number
            in here.
          </p>
        </div>

        {state && !state.ok ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.message}</p>
          </div>
        ) : null}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Sending…' : 'Ask for a way back in'}
        </Button>
      </form>
    </Card>
  );
}
