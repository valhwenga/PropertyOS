'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { signIn, type SignInState } from './actions';

const initial: SignInState = { error: null };

export function SignInForm() {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold text-ink-900">Sign in</h1>

      {state.error ? (
        <ErrorState title="Could not sign in" detail={state.error} correlationId={state.correlationId} />
      ) : null}

      {state.mfaRequired ? (
        <Card className="border-info-700/25 bg-info-50 p-3">
          <p className="text-sm text-info-700">
            Enter the 6-digit code from your authenticator app to finish signing in.
          </p>
        </Card>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-sm font-medium text-ink-700">
          Email address
        </label>
        <input
          id="email" name="email" type="email" required autoComplete="username"
          defaultValue={state.pendingEmail ?? ''}
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-medium text-ink-700">
          Password
        </label>
        <input
          id="password" name="password" type="password" required autoComplete="current-password"
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
      </div>

      {state.mfaRequired ? (
        <div className="space-y-1.5">
          <label htmlFor="code" className="block text-sm font-medium text-ink-700">
            Authentication code
          </label>
          <input
            id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} required autoFocus
            className="tabular w-full rounded-lg border border-ink-200 px-3 py-2 text-lg tracking-widest"
          />
        </div>
      ) : null}

      <Button type="submit" variant="primary" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : state.mfaRequired ? 'Verify and sign in' : 'Sign in'}
      </Button>
    </form>
  );
}
