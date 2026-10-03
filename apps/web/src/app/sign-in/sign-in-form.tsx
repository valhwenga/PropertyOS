'use client';

import { useActionState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import { signIn } from './actions';

const initial = { error: null as string | null, correlationId: undefined as string | undefined };

export function SignInForm() {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold text-ink-900">Sign in</h1>

      {state.error ? (
        <ErrorState title="Could not sign in" detail={state.error} correlationId={state.correlationId} />
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-sm font-medium text-ink-700">
          Email address
        </label>
        <input
          id="email" name="email" type="email" required autoComplete="username"
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

      <Button type="submit" variant="primary" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
