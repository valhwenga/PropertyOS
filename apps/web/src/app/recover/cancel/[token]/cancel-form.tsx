'use client';

import { useActionState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { cancelRecoveryAction } from './actions';

export function CancelRecoveryForm({ cancelToken }: { cancelToken: string }) {
  const [state, action, pending] = useActionState(cancelRecoveryAction, null);

  if (state?.ok) {
    return (
      <Card className="space-y-2 p-6">
        <h2 className="text-sm font-semibold text-ink-900">Stopped.</h2>
        <p className="text-sm text-ink-700">
          The recovery link will not work. Nothing about your account was changed, and your
          password and authenticator are as they were.
        </p>
        <p className="text-sm text-ink-700">
          If you did not ask for this, tell Spike support now — somebody asked for a way
          into your account and claimed to be you.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3 p-6">
      <p className="text-sm text-ink-700">
        This stops the recovery. Your password and authenticator stay exactly as they are,
        and the link that was issued will not work.
      </p>
      {state && !state.ok ? (
        <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{state.message}</p>
        </div>
      ) : null}
      <form action={action}>
        <input type="hidden" name="cancelToken" value={cancelToken} />
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? 'Stopping…' : 'Stop this recovery'}
        </Button>
      </form>
    </Card>
  );
}
