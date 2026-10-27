'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  changePlanAction, closeSupportSessionAction, openSupportSessionAction,
  setAccountStatusAction,
} from './actions';

/**
 * The operator's controls. Every one of them asks for a reason, because every
 * one of them is recorded against a named person in the customer's audit trail
 * and shown back to the customer.
 */

interface Outcome { ok?: boolean; message?: string; correlationId?: string }

const FIELD = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm';

function Result({ state, done }: { state: Outcome | null; done: string }) {
  if (!state) return null;
  if (state.ok) {
    return <p className="text-sm font-medium text-positive-600">{done}</p>;
  }
  return (
    <ErrorState
      title="That did not go through"
      detail={state.message ?? 'Something went wrong and the change was not made.'}
      correlationId={state.correlationId}
    />
  );
}

export interface PlanOption {
  key: string;
  name: string;
  includedUnits: number;
  priceLabel: string;
}

export function PlanForm({
  organisationId, slug, planKey, plans, billableUnits,
}: {
  organisationId: string; slug: string; planKey: string | null;
  plans: PlanOption[]; billableUnits: number;
}) {
  const [state, action, pending] = useActionState(changePlanAction, null);
  // A plan whose allowance is already exceeded by what the customer HAS is
  // offered, with the consequence stated: moving them down does not delete a
  // unit, it stops them adding the next one. Hiding the option would leave an
  // operator wondering why a downgrade they were asked for is impossible.
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Plan</h2>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="slug" value={slug} />
        <div className="space-y-1.5">
          <label htmlFor="planKey" className="block text-sm font-medium text-ink-700">
            Move to
          </label>
          <select id="planKey" name="planKey" defaultValue={planKey ?? ''} className={FIELD}>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} — {p.includedUnits} units, {p.priceLabel}
                {p.includedUnits < billableUnits ? ' (below their current usage)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="plan-reason" className="block text-sm font-medium text-ink-700">
            Why
          </label>
          <input
            id="plan-reason" name="reason" required minLength={5} className={FIELD}
            placeholder="Upgrade agreed on call, ticket SPK-1182"
          />
          <p className="text-xs text-ink-500">
            Recorded in the customer&rsquo;s own audit trail against your name.
          </p>
        </div>
        <Result state={state} done="Plan changed." />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Changing…' : 'Change plan'}
        </Button>
      </form>
    </Card>
  );
}

const STATUS_CONSEQUENCE: Record<string, string> = {
  trial: 'Full access. A trial is not treated differently anywhere in the product yet.',
  active: 'Full access.',
  suspended:
    'Their staff cannot open the console. Records, contracts and financial history are '
    + 'untouched, billing keeps running, and residents keep their portal.',
  closed:
    'Their staff cannot open the console. Their records are kept until the retention date '
    + 'on the closure below, and can be destroyed after it.',
};

export function AccountStatusForm({
  organisationId, slug, status,
}: {
  organisationId: string; slug: string; status: string;
}) {
  const [state, action, pending] = useActionState(setAccountStatusAction, null);
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Account status</h2>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="slug" value={slug} />
        <div className="space-y-1.5">
          <label htmlFor="status" className="block text-sm font-medium text-ink-700">
            Set to
          </label>
          <select id="status" name="status" defaultValue={status} className={FIELD}>
            <option value="trial">Trial</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          <p className="text-xs text-ink-500">{STATUS_CONSEQUENCE[status]}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="status-reason" className="block text-sm font-medium text-ink-700">
            Why
          </label>
          <input
            id="status-reason" name="reason" required minLength={5} className={FIELD}
            placeholder="Non-payment, third notice sent 14 March"
          />
        </div>
        <Result state={state} done="Account status changed." />
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Change status'}
        </Button>
      </form>
    </Card>
  );
}

export function SupportSessionForm({
  organisationId, slug, openWindow,
}: {
  organisationId: string; slug: string;
  openWindow: { expiresAt: string; authorisedByName: string | null; scopes: string[] } | null;
}) {
  const [state, action, pending] = useActionState(openSupportSessionAction, null);
  const opened = state?.ok
    ? (state as unknown as { expiresAt: string }).expiresAt
    : null;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Ask for a support session</h2>
      <p className="mt-1 text-sm text-ink-700">
        Time limited, and shown to the customer in their own settings with your name and this
        reason. Every record you open and every change you make is recorded against it.
      </p>
      {openWindow ? (
        <p className="mt-2 rounded-lg border border-positive-600/25 bg-positive-50 p-3 text-sm text-ink-700">
          <strong>They have let support in until {openWindow.expiresAt.slice(0, 16).replace('T', ' ')}</strong>
          {openWindow.authorisedByName ? ` — ${openWindow.authorisedByName} opened the window` : ''}.
          A session you open now is approved on arrival, and cannot outlast that window.
          {openWindow.scopes.length > 0
            ? ` They allowed changes to: ${openWindow.scopes.join(', ')}.`
            : ' They allowed reading only, so a session opened now can change nothing.'}
        </p>
      ) : (
        <p className="mt-2 rounded-lg border border-info-700/25 bg-info-50 p-3 text-sm text-ink-700">
          <strong>This reaches nothing until they approve it.</strong> There is no window open,
          so the session will sit on their support access screen, showing your name and your
          reason, until an administrator there approves it. Nothing here can approve it for them.
        </p>
      )}
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="slug" value={slug} />
        <div className="space-y-1.5">
          <label htmlFor="support-reason" className="block text-sm font-medium text-ink-700">
            Reason, including the ticket reference
          </label>
          <textarea
            id="support-reason" name="reason" required minLength={10} rows={2} className={FIELD}
            placeholder="SPK-1182: statement shows a duplicate receipt, approved by M. Dlamini on the call"
          />
          <p className="text-xs text-ink-500">
            This is what the customer reads when deciding, so write it for them: the ticket,
            and what you need to look at.
          </p>
        </div>
        {openWindow && openWindow.scopes.length > 0 ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-ink-700">
              What you need to be able to change
            </legend>
            <p className="text-xs text-ink-500">
              Only what they have already allowed is listed. Asking for nothing is reading
              only, which is the right choice unless a change is the point of the call.
            </p>
            {openWindow.scopes.map((scope: string) => (
              <label
                key={scope}
                htmlFor={`scope-${scope}`}
                className="flex items-center gap-2 text-sm text-ink-700"
              >
                <input
                  id={`scope-${scope}`} type="checkbox" name="scopes" value={scope}
                  className="h-4 w-4 rounded border-ink-300"
                />
                {scope}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="hours" className="block text-sm font-medium text-ink-700">
            For how long
          </label>
          <select id="hours" name="hours" defaultValue="2" className={FIELD}>
            <option value="1">1 hour</option>
            <option value="2">2 hours</option>
            <option value="4">4 hours</option>
            <option value="8">8 hours</option>
            <option value="24">24 hours — the maximum</option>
          </select>
        </div>
        <Result state={state} done={opened ? `Open until ${opened.slice(0, 16).replace('T', ' ')}.` : 'Opened.'} />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Opening…' : 'Open session'}
        </Button>
      </form>
    </Card>
  );
}

export function CloseSessionButton({
  supportSessionId, slug,
}: {
  supportSessionId: string; slug: string;
}) {
  const [state, action, pending] = useActionState(closeSupportSessionAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="supportSessionId" value={supportSessionId} />
      <input type="hidden" name="slug" value={slug} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Closing…' : 'Close now'}
      </Button>
      {state && !state.ok ? (
        <p className="mt-1 text-xs text-critical-700">{state.message}</p>
      ) : null}
    </form>
  );
}
