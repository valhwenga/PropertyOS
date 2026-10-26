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

export interface ScopeChoice { key: string; name: string; description: string }

/**
 * What the customer is agreeing to let Spike change.
 *
 * Unticked is the default and is the behaviour support access has always had:
 * look, change nothing. The words come from the database, from the same rows
 * that decide what a scope actually permits, so this list cannot drift from
 * what will really be allowed.
 */
function ScopeChoices({
  scopes, idPrefix, legend,
}: { scopes: ScopeChoice[]; idPrefix: string; legend: string }) {
  if (scopes.length === 0) return null;
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-ink-700">{legend}</legend>
      <p className="text-xs text-ink-500">
        Leave these unticked and support can look and change nothing, which is how
        support access has always worked.
      </p>
      {scopes.map((scope) => (
        <label
          key={scope.key}
          htmlFor={`${idPrefix}-${scope.key}`}
          className="flex gap-2.5 rounded-lg border border-ink-100 p-2.5"
        >
          <input
            id={`${idPrefix}-${scope.key}`} type="checkbox" name="scopes" value={scope.key}
            className="mt-0.5 h-4 w-4 rounded border-ink-300"
          />
          <span>
            <span className="block text-sm font-medium text-ink-900">{scope.name}</span>
            <span className="block text-xs text-ink-600">{scope.description}</span>
          </span>
        </label>
      ))}
      <p className="text-xs text-ink-500">
        Whatever you tick, support can never move money, change your bank details, add
        anybody to your organisation, extend its own access, or open identity documents.
        Everything it does is recorded against the session and you can end it at any
        moment.
      </p>
    </fieldset>
  );
}

function Failure({ state }: { state: Outcome | null }) {
  if (!state || state.ok) return null;
  return (
    <p className="mt-1 text-xs text-critical-700">
      {state.message ?? 'That did not go through.'}
    </p>
  );
}

export function ApproveSessionButton({
  supportSessionId, org, operatorName, scopes,
}: {
  supportSessionId: string; org: string; operatorName: string; scopes: ScopeChoice[];
}) {
  const [state, action, pending] = useActionState(approveSupportSessionAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="supportSessionId" value={supportSessionId} />
      <input type="hidden" name="org" value={org} />
      <ScopeChoices
        scopes={scopes}
        idPrefix={`approve-${supportSessionId}`}
        legend={`May ${operatorName} change anything?`}
      />
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

export function OpenWindowForm({ org, scopes }: { org: string; scopes: ScopeChoice[] }) {
  const [state, action, pending] = useActionState(openSupportWindowAction, null);
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Let support in in advance</h2>
      <p className="mt-1 text-sm text-ink-700">
        For when you are about to raise a query and would rather support could look
        straight away than wait for you to approve each request. Any session opened
        inside the window is approved as it arrives, cannot outlast the window, and is
        recorded against your name. It can change only what you tick below — nothing,
        unless you say otherwise.
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
        <ScopeChoices
          scopes={scopes}
          idPrefix="window"
          legend="What support may change while the window is open"
        />
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
