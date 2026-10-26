'use client';

import { useActionState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { acceptOperatorInvitationAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function JoinOperatorForm({
  token, fullName, email, roleNames, hasAccount,
}: {
  token: string; fullName: string; email: string;
  roleNames: string[]; hasAccount: boolean;
}) {
  const [state, action, pending] = useActionState(acceptOperatorInvitationAction, { error: null });

  return (
    <Card className="p-6">
      <p className="text-sm font-medium text-spike-600">Spike PropertyOS</p>
      <h1 className="mt-1 text-lg font-semibold text-ink-900">
        {fullName}, you have been invited to the platform team
      </h1>
      <p className="mt-2 text-sm text-ink-700">
        As <strong>{roleNames.join(' and ') || 'an operator'}</strong>, for{' '}
        <span className="tabular">{email}</span>.
      </p>
      <p className="mt-2 text-sm text-ink-500">
        Being an operator admits you to Spike's own console. It does not admit you to any
        customer's records: that needs a support session the customer authorises, which is
        time limited and audited.
      </p>

      <form action={action} className="mt-5 space-y-4">
        <input type="hidden" name="token" value={token} />

        {state.error ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.error}</p>
          </div>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="password">
            {hasAccount ? 'Your existing password' : 'Choose a password'}
          </label>
          <input
            id="password" name="password" type="password" required minLength={12}
            autoComplete={hasAccount ? 'current-password' : 'new-password'}
            className={`mt-1 ${FIELD}`}
          />
          <p className="mt-1 text-xs text-ink-500">
            {hasAccount
              ? 'This address already has an account. Your own password confirms it is you — '
                + 'an invitation link is not proof of identity.'
              : 'At least 12 characters.'}
          </p>
        </div>

        <div>
          <label className={LABEL} htmlFor="confirmPassword">
            {hasAccount ? 'Again, to be sure' : 'Confirm it'}
          </label>
          <input
            id="confirmPassword" name="confirmPassword" type="password" required minLength={12}
            autoComplete={hasAccount ? 'current-password' : 'new-password'}
            className={`mt-1 ${FIELD}`}
          />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Accepting…' : 'Accept and continue'}
        </Button>
        <p className="text-xs text-ink-500">
          The console requires a second factor, so the next step is enrolling an
          authenticator. Until you do, the console stays closed.
        </p>
      </form>
    </Card>
  );
}
