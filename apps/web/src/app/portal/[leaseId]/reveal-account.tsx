'use client';

import { useActionState } from 'react';
import { revealAccountNumber } from './actions';
import { CopyField } from './copy-field';

/**
 * The full account number, on request.
 *
 * Not rendered with the page. A resident needs it — they cannot pay without
 * it, and the first time they pay they have nothing to check the last four
 * digits against — but it does not belong in the HTML of every page load, in a
 * screenshot, or over somebody's shoulder on a taxi.
 *
 * Asking fetches it through a server action that re-checks the portal link and
 * writes an audit entry naming the account. The number itself never reaches
 * that entry, a log or an analytics payload.
 */
export function RevealAccountNumber({ leaseId, last4 }: { leaseId: string; last4: string }) {
  const [state, action, pending] = useActionState(revealAccountNumber, null);

  if (state?.ok) {
    return (
      <div>
        <CopyField value={state.accountNumber} label="account number" />
        <p className="mt-1 text-xs text-ink-500">
          Check it ends in {last4} before you pay.
        </p>
      </div>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="leaseId" value={leaseId} />
      <p className="tabular text-sm text-ink-900">•••• {last4}</p>
      <button
        type="submit"
        disabled={pending}
        className="
          mt-1.5 min-h-9 rounded-lg border border-ink-200 px-2.5 text-xs font-medium text-ink-700
          hover:bg-ink-50 focus-visible:outline focus-visible:outline-2
          focus-visible:outline-offset-2 focus-visible:outline-spike-500
        "
      >
        {pending ? 'Showing…' : 'Show the full number'}
      </button>
      {state && !state.ok ? (
        <p className="mt-1.5 text-xs text-critical-700">{state.message}</p>
      ) : null}
    </form>
  );
}
