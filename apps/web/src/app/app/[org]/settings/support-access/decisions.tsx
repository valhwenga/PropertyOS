'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  approveSupportSessionAction, closeSupportWindowAction, endSupportSessionAction,
  openSupportWindowAction,
} from './actions';

/**
 * The customer's controls over Spike support access.
 *
 * None of these shows a success message. Every one of them marks the page
 * stale, so the row it acted on comes back in its new state and the banners
 * above the tables turn over — which says more than a line of text beside a
 * button that has itself disappeared. A browser test caught the first version
 * of this asserting a message that could never render.
 */

interface Outcome { ok?: boolean; message?: string; correlationId?: string }

const FIELD = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm';

function Failure({ state }: { state: Outcome | null }) {
  if (!state || state.ok) return null;
  return (
    <p className="mt-1 text-xs text-critical-700">
      {state.message ?? 'That did not go through.'}
    </p>
  );
}

export function ApproveSessionButton({
  supportSessionId, org, operatorName,
}: {
  supportSessionId: string; org: string; operatorName: string;
}) {
  const [state, action, pending] = useActionState(approveSupportSessionAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="supportSessionId" value={supportSessionId} />
      <input type="hidden" name="org" value={org} />
      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        aria-label={`Let ${operatorName} in`}
      >
        {pending ? 'Approving…' : 'Let them in'}
      </Button>
      <Failure state={state} />
    </form>
  );
}

/**
 * Declining a request and ending a live session are the same button on the
 * same record, worded for what the record currently is. Both revoke it; a
 * declined request keeps its row, so the history still shows that Spike asked.
 */
export function EndSessionButton({
  supportSessionId, org, operatorName, waiting,
}: {
  supportSessionId: string; org: string; operatorName: string; waiting: boolean;
}) {
  const [state, action, pending] = useActionState(endSupportSessionAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="supportSessionId" value={supportSessionId} />
      <input type="hidden" name="org" value={org} />
      <Button
        type="submit"
        disabled={pending}
        aria-label={waiting ? `Decline ${operatorName}` : `End ${operatorName}'s access now`}
      >
        {pending ? 'Working…' : waiting ? 'Decline' : 'End access now'}
      </Button>
      <Failure state={state} />
    </form>
  );
}

export function OpenWindowForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(openSupportWindowAction, null);
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Let support in in advance</h2>
      <p className="mt-1 text-sm text-ink-700">
        For when you are about to raise a query and would rather support could look
        straight away than wait for you to approve each request. Any session opened
        inside the window is approved as it arrives, cannot outlast the window, and is
        still read-only and still recorded against your name.
      </p>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="org" value={org} />
        <div className="space-y-1.5">
          <label htmlFor="window-reason" className="block text-sm font-medium text-ink-700">
            What this is for
          </label>
          <input
            id="window-reason" name="reason" required minLength={5} className={FIELD}
            placeholder="Raising a query about the March statement"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="hours" className="block text-sm font-medium text-ink-700">
            For how long
          </label>
          <select id="hours" name="hours" defaultValue="4" className={FIELD}>
            <option value="1">1 hour</option>
            <option value="4">4 hours</option>
            <option value="8">8 hours</option>
            <option value="24">24 hours</option>
            <option value="72">3 days — the maximum</option>
          </select>
        </div>
        {state && !state.ok ? (
          <ErrorState
            title="That did not go through"
            detail={state.message ?? 'The window was not opened.'}
            correlationId={state.correlationId}
          />
        ) : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Opening…' : 'Open the window'}
        </Button>
      </form>
    </Card>
  );
}

export function CloseWindowButton({ grantId, org }: { grantId: string; org: string }) {
  const [state, action, pending] = useActionState(closeSupportWindowAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="grantId" value={grantId} />
      <input type="hidden" name="org" value={org} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Closing…' : 'Close the window'}
      </Button>
      <Failure state={state} />
    </form>
  );
}
