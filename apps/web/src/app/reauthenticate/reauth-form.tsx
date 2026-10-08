'use client';

import { useActionState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import { reauthenticate, type ReauthState } from './actions';

const initial: ReauthState = { error: null };

export function ReauthForm({ returnTo }: { returnTo: string }) {
  const [state, action, pending] = useActionState(reauthenticate, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="returnTo" value={returnTo} />

      {state.error ? (
        <ErrorState
          title="Could not confirm it is you"
          detail={state.error}
          correlationId={state.correlationId}
        />
      ) : null}

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

      <Button type="submit" variant="primary" className="w-full" disabled={pending}>
        {pending ? 'Confirming…' : 'Confirm and continue'}
      </Button>
    </form>
  );
}
