'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { acceptPortalInvitationAction } from './actions';

export function PortalJoinForm({
  token, organisationName, residentName, email, unitLabel, hasAccount,
}: {
  token: string; organisationName: string; residentName: string; email: string;
  unitLabel: string; hasAccount: boolean;
}) {
  const [state, action, pending] = useActionState(
    acceptPortalInvitationAction, { error: null },
  );

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />

        <h1 className="text-lg font-semibold text-ink-900">Your tenancy with {organisationName}</h1>
        <p className="text-sm text-ink-700">
          {residentName}, this gives you access to your own lease at <strong>{unitLabel}</strong>:
          your statement, your documents and your maintenance requests. Your sign-in address
          will be <strong>{email}</strong>.
        </p>

        {state.error ? (
          <ErrorState
            title="Could not accept this invitation" detail={state.error}
            correlationId={state.correlationId}
          />
        ) : null}

        {hasAccount ? (
          <p className="text-sm text-ink-700">
            You already have an account with this address. Enter your existing password to
            confirm it is you — accepting will not change it.
          </p>
        ) : (
          <p className="text-sm text-ink-500">
            Choose a password of at least 12 characters. Nobody at {organisationName} and
            nobody at Spike can see it.
          </p>
        )}

        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-ink-700">
            {hasAccount ? 'Your password' : 'Choose a password'}
          </label>
          <input
            id="password" name="password" type="password" required minLength={12}
            autoComplete={hasAccount ? 'current-password' : 'new-password'}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-ink-700">
            {hasAccount ? 'Your password again' : 'The same password again'}
          </label>
          <input
            id="confirmPassword" name="confirmPassword" type="password" required minLength={12}
            autoComplete={hasAccount ? 'current-password' : 'new-password'}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Setting up…' : 'Open my tenancy'}
        </Button>
      </form>
    </Card>
  );
}
