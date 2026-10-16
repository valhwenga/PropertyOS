'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { signIn, type SignInState } from './actions';

const initial: SignInState = { error: null };

export function SignInForm() {
  const [state, action, pending] = useActionState(signIn, initial);
  const [usingRecovery, setUsingRecovery] = useState(false);

  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold text-ink-900">Sign in</h1>

      {state.error ? (
        <ErrorState title="Could not sign in" detail={state.error} correlationId={state.correlationId} />
      ) : null}

      {state.mfaRequired ? (
        <Card className="border-info-700/25 bg-info-50 p-3">
          <p className="text-sm text-info-700">
            Enter the 6-digit code from your authenticator app to finish signing in, and your
            password again — the browser clears it between the two steps, so leaving it empty
            stops the form without saying why.
          </p>
        </Card>
      ) : null}

      {state.mfaRequired && usingRecovery ? (
        <Card className="border-caution-700/30 bg-caution-50 p-3">
          <p className="text-sm text-caution-700">
            A recovery code is used once and then gone. Use one only if you cannot reach your
            authenticator app — you will be taken straight to your security settings to set up
            a new one.
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
          {state.mfaRequired ? 'Password, again' : 'Password'}
        </label>
        <input
          id="password" name="password" type="password" required autoComplete="current-password"
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
      </div>

      {state.mfaRequired && !usingRecovery ? (
        <div className="space-y-1.5">
          <label htmlFor="code" className="block text-sm font-medium text-ink-700">
            Authentication code
          </label>
          <input
            id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} required autoFocus
            className="tabular w-full rounded-lg border border-ink-200 px-3 py-2 text-lg tracking-widest"
          />
          <button
            type="button"
            onClick={() => setUsingRecovery(true)}
            className="text-sm text-spike-600 hover:underline"
          >
            I cannot reach my authenticator app
          </button>
        </div>
      ) : null}

      {state.mfaRequired && usingRecovery ? (
        <div className="space-y-1.5">
          <label htmlFor="recoveryCode" className="block text-sm font-medium text-ink-700">
            Recovery code
          </label>
          <input
            id="recoveryCode" name="recoveryCode" type="text" autoComplete="one-time-code"
            placeholder="ABCDE-FGHJK" required autoFocus
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-lg tracking-wider"
          />
          <button
            type="button"
            onClick={() => setUsingRecovery(false)}
            className="text-sm text-spike-600 hover:underline"
          >
            Use my authenticator app instead
          </button>
        </div>
      ) : null}

      <Button type="submit" variant="primary" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : state.mfaRequired ? 'Verify and sign in' : 'Sign in'}
      </Button>
    </form>
  );
}
