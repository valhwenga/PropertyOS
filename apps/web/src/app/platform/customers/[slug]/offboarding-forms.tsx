'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import {
  closeCustomerAction, destroyCustomerDataAction, setRetentionAction,
} from './actions';

/**
 * A customer leaving, in the order it happens.
 *
 * One card with three states, rather than three cards: closing, the retention
 * period running, and the records gone. An operator opening this page needs to
 * know which of those is true before anything else, and a panel that shows a
 * destroy button beside a close button is a panel somebody will misread.
 *
 * The destroy form is the only place in this console that asks somebody to
 * type something. The permission is already the guard; the typing is there
 * because this is the one action with nothing behind it, and clicking the
 * wrong customer's row should not be enough to end their records.
 */

const FIELD =
  'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

export interface ClosureView {
  closedAt: string;
  closedByName: string | null;
  reason: string;
  retainUntil: string;
  destroyedAt: string | null;
  destroyedByName: string | null;
  destructionReason: string | null;
  rowsDestroyed: number | null;
  objectsRemoved: number | null;
  objectsLeft: string[];
  destructionDue: boolean;
}

function Failure({ state }: { state: Outcome | null }) {
  if (!state || state.ok) return null;
  return (
    <ErrorState
      title="That did not go through"
      detail={state.message ?? 'Something went wrong and nothing was changed.'}
      correlationId={state.correlationId}
    />
  );
}

export function ClosurePanel({
  organisationId, slug, customerName, closure, canClose, canDestroy, defaultRetentionMonths,
}: {
  organisationId: string;
  slug: string;
  customerName: string;
  closure: ClosureView | null;
  canClose: boolean;
  canDestroy: boolean;
  defaultRetentionMonths: number;
}) {
  const [closeState, close, closing] = useActionState(closeCustomerAction, null);
  const [retainState, retain, retaining] = useActionState(setRetentionAction, null);
  const [destroyState, destroy, destroying] = useActionState(destroyCustomerDataAction, null);
  const [open, setOpen] = useState<'close' | 'retain' | 'destroy' | null>(null);

  const hidden = (
    <>
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="slug" value={slug} />
    </>
  );

  // Destroyed: a tombstone, and nothing to do.
  if (closure?.destroyedAt) {
    return (
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-900">Closed and destroyed</h2>
          <StatusBadge tone="neutral" glyph="■">records destroyed</StatusBadge>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-ink-500">Destroyed</dt>
            <dd className="text-ink-900">
              {closure.destroyedAt.slice(0, 10)} by {closure.destroyedByName ?? 'an operator'} ·{' '}
              <span className="tabular">{closure.rowsDestroyed ?? 0}</span> rows
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Stored files</dt>
            <dd className="text-ink-900">
              {closure.objectsRemoved === null
                ? 'not recorded'
                : `${closure.objectsRemoved} removed from storage`}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Reason</dt>
            <dd className="text-ink-900">{closure.destructionReason}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Closed</dt>
            <dd className="text-ink-700">
              {closure.closedAt.slice(0, 10)} by {closure.closedByName ?? 'an operator'} —{' '}
              {closure.reason}
            </dd>
          </div>
        </dl>
        {closure.objectsLeft.length > 0 ? (
          <div className="mt-3 rounded-lg border border-critical-700/30 bg-critical-50 p-3">
            <p className="text-sm font-semibold text-critical-700">
              {closure.objectsLeft.length} file
              {closure.objectsLeft.length === 1 ? '' : 's'} are still in storage
            </p>
            <p className="mt-1 text-xs text-ink-700">
              The records are gone and these objects would not delete. Their keys are kept
              here so somebody can finish the job — a file left behind with its key written
              down is a job, and one with its key deleted is personal information nobody can
              find again.
            </p>
            <ul className="mt-2 space-y-0.5">
              {closure.objectsLeft.map((key) => (
                <li key={key} className="tabular break-all text-xs text-ink-700">{key}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mt-3 text-xs text-ink-500">
          What is left is Spike&rsquo;s own: the subscription invoices, this trail, and the
          record of the support sessions they authorised. The account cannot be reopened —
          it would open an empty console.
        </p>
      </Card>
    );
  }

  // Closed, retention running.
  if (closure) {
    const days = Math.ceil(
      (new Date(closure.retainUntil).getTime() - Date.now()) / 86_400_000,
    );
    return (
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-900">Closed</h2>
          <StatusBadge
            tone={closure.destructionDue ? 'critical' : 'caution'}
            glyph={closure.destructionDue ? '▲' : '◐'}
          >
            {closure.destructionDue ? 'may be destroyed' : `kept ${days} more day${days === 1 ? '' : 's'}`}
          </StatusBadge>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-ink-500">Closed</dt>
            <dd className="text-ink-900">
              {closure.closedAt.slice(0, 10)} by {closure.closedByName ?? 'an operator'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-500">Reason</dt>
            <dd className="text-ink-900">{closure.reason}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Records kept until</dt>
            <dd className="tabular text-ink-900">{closure.retainUntil}</dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-ink-500">
          Nothing happens on that date on its own. The customer can still download their
          whole archive from the page they are sent to instead of the console, and that is
          the only copy they will get.
        </p>

        <Failure state={retainState} />
        <Failure state={destroyState} />

        {canDestroy ? (
          <div className="mt-3 flex flex-wrap gap-3 border-t border-ink-100 pt-3">
            <button
              type="button"
              onClick={() => setOpen(open === 'retain' ? null : 'retain')}
              className="text-sm font-medium text-spike-600 hover:underline"
            >
              {open === 'retain' ? 'Cancel' : 'Move the retention date'}
            </button>
            {closure.destructionDue ? (
              <button
                type="button"
                onClick={() => setOpen(open === 'destroy' ? null : 'destroy')}
                className="text-sm font-medium text-critical-700 hover:underline"
              >
                {open === 'destroy' ? 'Cancel' : 'Destroy these records'}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 border-t border-ink-100 pt-3 text-xs text-ink-500">
            Moving that date and destroying records are administrators&rsquo; decisions.
          </p>
        )}

        {open === 'retain' ? (
          <form action={retain} className="mt-3 space-y-2">
            {hidden}
            <p className="text-xs text-ink-500">
              Bring it forward when the customer has asked in writing for their records to
              be removed sooner; push it out when something — a dispute, an audit — means
              they have to be kept. It decides when destruction becomes possible, not
              whether it happens.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-sm font-medium text-ink-700" htmlFor="retainUntil">
                  Keep until
                </label>
                <input
                  id="retainUntil" name="retainUntil" type="date" required
                  defaultValue={closure.retainUntil} className={`mt-1 ${FIELD}`}
                />
              </div>
              <div className="min-w-60 flex-1">
                <label className="block text-sm font-medium text-ink-700" htmlFor="retainReason">
                  Why
                </label>
                <input
                  id="retainReason" name="reason" required minLength={5} maxLength={500}
                  placeholder="The customer asked for removal in writing on SPK-7101"
                  className={`mt-1 ${FIELD}`}
                />
              </div>
              <Button type="submit" variant="primary" disabled={retaining}>
                {retaining ? 'Saving…' : 'Move the date'}
              </Button>
            </div>
          </form>
        ) : null}

        {open === 'destroy' ? (
          <form action={destroy} className="mt-3 space-y-2 rounded-lg border border-critical-700/30 bg-critical-50 p-3">
            {hidden}
            <p className="text-sm font-semibold text-critical-700">
              This cannot be undone.
            </p>
            <p className="text-xs text-ink-700">
              Every property, unit, lease, resident, contract, document, invoice, receipt,
              expense and journal under {customerName} is deleted, their uploaded files are
              removed from storage, and the people who belonged only to this account lose
              their name, email and login. What stays is
              Spike&rsquo;s: the subscription invoices, this audit trail, and the record of
              the support sessions they authorised. The account becomes a tombstone and
              cannot be reopened.
            </p>
            <div className="space-y-2">
              <div>
                <label className="block text-sm font-medium text-ink-700" htmlFor="confirmSlug">
                  Type <span className="tabular font-semibold">{slug}</span> to confirm
                </label>
                <input
                  id="confirmSlug" name="confirmSlug" required autoComplete="off"
                  placeholder={slug} className={`mt-1 ${FIELD}`}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700" htmlFor="destroyReason">
                  Why these records are being destroyed
                </label>
                <input
                  id="destroyReason" name="reason" required minLength={5} maxLength={500}
                  placeholder="The customer asked for removal in writing on SPK-7101"
                  className={`mt-1 ${FIELD}`}
                />
              </div>
            </div>
            <Button type="submit" variant="danger" disabled={destroying}>
              {destroying ? 'Destroying…' : 'Destroy these records'}
            </Button>
          </form>
        ) : null}
      </Card>
    );
  }

  // Open account: the way out.
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Close the account</h2>
      <p className="mt-1 text-xs text-ink-500">
        For a customer who is leaving. Their staff lose the console, their records are kept
        until a date you set here, and only after that date can anybody destroy them. The
        page they are sent to instead of the console carries their own download and that
        date.
      </p>
      <Failure state={closeState} />
      {canClose ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(open === 'close' ? null : 'close')}
            className="mt-3 text-sm font-medium text-spike-600 hover:underline"
          >
            {open === 'close' ? 'Cancel' : 'Close this account'}
          </button>
          {open === 'close' ? (
            <form action={close} className="mt-3 space-y-2">
              {hidden}
              <div>
                <label className="block text-sm font-medium text-ink-700" htmlFor="closeReason">
                  Why the account is closing
                </label>
                <input
                  id="closeReason" name="reason" required minLength={5} maxLength={500}
                  placeholder="The customer sold the portfolio and asked to close on SPK-7100"
                  className={`mt-1 ${FIELD}`}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700" htmlFor="retainMonths">
                  Keep their records for
                </label>
                <select
                  id="retainMonths" name="retainMonths"
                  defaultValue={String(defaultRetentionMonths)} className={`mt-1 ${FIELD}`}
                >
                  <option value="0">Until they ask (destroy as soon as they request it)</option>
                  <option value="12">12 months</option>
                  <option value="24">24 months</option>
                  <option value="60">60 months — five years</option>
                  <option value="84">84 months — seven years</option>
                </select>
                <p className="mt-1 text-xs text-ink-500">
                  The platform default is {defaultRetentionMonths} months. A landlord&rsquo;s
                  financial records are commonly kept for five years in South Africa; this
                  is Spike&rsquo;s own setting and not advice.
                </p>
              </div>
              <Button type="submit" variant="danger" disabled={closing}>
                {closing ? 'Closing…' : 'Close the account'}
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-500">
          Closing an account is an administrator&rsquo;s decision.
        </p>
      )}
    </Card>
  );
}
