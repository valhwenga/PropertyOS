'use client';

import { useActionState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { completeRecoveryAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

/**
 * The end of a recovery: setting a new password, clearing a lost authenticator,
 * or both — whichever was asked for and approved, and nothing else.
 */
export function RecoverLinkForm({
  token, lost,
}: { token: string; lost: 'password' | 'second_factor' | 'both' }) {
  const [state, action, pending] = useActionState(completeRecoveryAction, null);
  const needsPassword = lost === 'password' || lost === 'both';
  const clearsFactor = lost === 'second_factor' || lost === 'both';

  if (state?.ok) {
    return (
      <Card className="space-y-3 p-6">
        <h2 className="text-sm font-semibold text-ink-900">Done. Sign in.</h2>
        {needsPassword ? (
          <p className="text-sm text-ink-700">Use your new password.</p>
        ) : null}
        {clearsFactor ? (
          <p className="text-sm text-ink-700">
            Your old authenticator has been removed. Sign in with your password, then set up
            a new authenticator under <strong className="font-medium">Security</strong> in
            your account — until you do, anything that needs a second factor will be
            refused, which is deliberate.
          </p>
        ) : (
          <p className="text-sm text-ink-700">
            Your authenticator still works and you will be asked for a code, as usual.
          </p>
        )}
        <p>
          <a href="/sign-in" className="text-sm font-medium text-spike-600 underline underline-offset-2">
            Go to the sign-in page
          </a>
        </p>
        <p className="text-xs text-ink-500">
          This link has now been used and will not work again.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="needsPassword" value={needsPassword ? 'yes' : 'no'} />

        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-700">
          <p className="font-medium text-ink-900">What this link does</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {needsPassword ? <li>Sets a new password.</li> : null}
            {clearsFactor ? <li>Removes the authenticator you lost, and its recovery codes.</li> : null}
            {!clearsFactor ? <li>Leaves your authenticator alone — you will still need a code.</li> : null}
          </ul>
        </div>

        {needsPassword ? (
          <>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-ink-700">
                New password
              </label>
              <input
                id="password" name="password" type="password" required minLength={12}
                autoComplete="new-password" className={`mt-1 ${FIELD}`}
              />
              <p className="mt-1 text-xs text-ink-500">At least 12 characters.</p>
            </div>
            <div>
              <label htmlFor="confirm" className="block text-sm font-medium text-ink-700">
                Again
              </label>
              <input
                id="confirm" name="confirm" type="password" required minLength={12}
                autoComplete="new-password" className={`mt-1 ${FIELD}`}
              />
            </div>
          </>
        ) : null}

        {state && !state.ok ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.message}</p>
          </div>
        ) : null}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : needsPassword ? 'Set my password' : 'Remove my old authenticator'}
        </Button>
      </form>
    </Card>
  );
}
