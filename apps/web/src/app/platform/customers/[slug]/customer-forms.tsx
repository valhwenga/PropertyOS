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
    'Their staff cannot open the console. Nothing is deleted — closing an account is not '
    + 'a deletion request, and there is no path here that deletes a customer.',
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
            <option value="closed">Closed</option>
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
  organisationId, slug,
}: {
  organisationId: string; slug: string;
}) {
  const [state, action, pending] = useActionState(openSupportSessionAction, null);
  const opened = state?.ok
    ? (state as unknown as { expiresAt: string }).expiresAt
    : null;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Open a support session</h2>
      <p className="mt-1 text-sm text-ink-700">
        Read-only, time limited, and shown to the customer in their own settings with your
        name and this reason. Every record you open under it is recorded against it.
      </p>
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
            Name who at the customer approved it. The approval cannot be recorded as a link
            yet — there is no screen on their side that grants access in advance — so the
            session will be shown to them as <strong>not authorised by you</strong> until
            that exists.
          </p>
        </div>
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
