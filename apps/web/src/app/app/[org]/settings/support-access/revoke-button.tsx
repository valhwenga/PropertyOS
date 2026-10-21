'use client';

import { useActionState } from 'react';
import { Button } from '@propertyos/ui';
import { revokeSupportSessionAction } from './actions';

/**
 * Ends a support session now.
 *
 * No confirmation step: revoking access is the safe direction, and a dialogue
 * between somebody and the removal of a stranger's access to their records
 * would be an obstacle in front of the right answer. Re-opening one requires
 * Spike to ask again, with a reason, which is recorded.
 *
 * No success message either, and that is not an omission. The action marks the
 * page stale, so the row re-renders as revoked and the banner above the table
 * becomes "No open support sessions" — which says more than a line of
 * confirmation next to a button that has itself disappeared. A success branch
 * written here cannot render at all, because this component is gone by the time
 * it would: the browser test caught exactly that.
 */
export function RevokeSupportSessionButton({
  supportSessionId, org, operatorName,
}: {
  supportSessionId: string; org: string; operatorName: string;
}) {
  const [state, action, pending] = useActionState(revokeSupportSessionAction, null);

  return (
    <form action={action}>
      <input type="hidden" name="supportSessionId" value={supportSessionId} />
      <input type="hidden" name="org" value={org} />
      <Button type="submit" disabled={pending} aria-label={`End ${operatorName}'s access now`}>
        {pending ? 'Ending…' : 'End access now'}
      </Button>
      {state && !state.ok ? (
        <p className="mt-1 text-xs text-critical-700">{state.message}</p>
      ) : null}
    </form>
  );
}
