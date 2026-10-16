'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { acceptInvitationAction } from './actions';

export function JoinForm({
  token, organisationName, fullName, email, roles, hasAccount,
}: {
  token: string; organisationName: string; fullName: string; email: string;
  roles: string[]; hasAccount: boolean;
}) {
  const [state, action, pending] = useActionState(acceptInvitationAction, { error: null });

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />

        <h1 className="text-lg font-semibold text-ink-900">
          Join {organisationName}
        </h1>
        <p className="text-sm text-ink-700">
          {fullName}, you have been invited to {organisationName} as{' '}
          <strong>{roles.join(', ')}</strong>. Your sign-in address will be{' '}
          <strong>{email}</strong>.
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
            Choose a password of at least 12 characters. Nobody at this organisation or at
            Spike can see it.
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
          {pending ? 'Joining…' : `Join ${organisationName}`}
        </Button>

        <p className="text-xs text-ink-500">
          Some roles need an authenticator app before their permissions take effect. If yours
          does, you will be able to sign in and will see very little until you add one.
        </p>
      </form>
    </Card>
  );
}
