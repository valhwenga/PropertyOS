'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import { DateField } from '@/components/date-field';
import { DeliveryNote } from '@/components/delivery-note';
import { FieldErrors } from '@/components/field-errors';
import { extendLeaseAction, terminateLeaseAction } from './actions';

/**
 * Dates arrive already formatted.
 *
 * A server component cannot hand a client component a function, so the
 * formatter cannot come across the boundary — and the organisation's time zone
 * lives on the server anyway. Formatting there and passing strings keeps one
 * source of truth for how a date reads.
 */
export interface LifecycleEvent {
  id: string;
  kind: 'terminated' | 'extended';
  reason: string;
  effectiveDateDisplay: string;
  previousEndDateDisplay: string | null;
  recordedAtDisplay: string;
  recordedBy: string | null;
}

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

/**
 * Ending or extending the lease, and the record of both.
 *
 * The reason is required by the database, not just by this form: the history
 * row and the change to the lease are written in one transaction, so a lease
 * cannot end without someone saying why.
 */
export function LifecyclePanel({
  org, leaseId, status, endDateDisplay, events,
}: {
  org: string; leaseId: string; status: string; endDateDisplay: string | null;
  events: LifecycleEvent[];
}) {
  const [termState, termAction, terminating] = useActionState(terminateLeaseAction, null);
  const [extState, extAction, extending] = useActionState(extendLeaseAction, null);
  const [open, setOpen] = useState<'none' | 'end' | 'extend'>('none');
  const ended = status === 'closed' || status === 'cancelled';

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Term changes
        </h2>
        {ended ? (
          <StatusBadge tone="neutral">This lease has ended</StatusBadge>
        ) : (
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(open === 'extend' ? 'none' : 'extend')}
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
              Extend
            </button>
            <button type="button" onClick={() => setOpen(open === 'end' ? 'none' : 'end')}
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
              End the lease
            </button>
          </div>
        )}
      </div>

      {/* Who was told, and whether the email actually went out. This sits outside
          both forms on purpose: ending a lease closes it, which hides the form,
          and the operator still needs to see what reached the resident. */}
      {termState?.ok ? (
        <DeliveryNote
          inbox={termState.inbox} email={termState.email} emailDetail={termState.emailDetail}
          nobody="The lease has ended. Nobody on it has a portal account, so no notice was sent."
        />
      ) : null}
      {extState?.ok ? (
        <DeliveryNote
          inbox={extState.inbox} email={extState.email} emailDetail={extState.emailDetail}
          nobody="The lease has been extended. Nobody on it has a portal account, so no notice was sent."
        />
      ) : null}

      {open === 'extend' && !ended ? (
        <Card className="p-4">
          <form action={extAction} className="space-y-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="leaseId" value={leaseId} />
            {extState && !extState.ok ? (
              <div>
                <ErrorState title="Could not extend this lease" detail={extState.message}
                            correlationId={extState.correlationId} />
                <FieldErrors errors={extState.fieldErrors} />
              </div>
            ) : null}
            <DateField name="newEndDate" label="New end date" required
                       hint={endDateDisplay
                         ? `Currently ends ${endDateDisplay}. An extension must be later.`
                         : 'This lease has no end date recorded.'} />
            <div>
              <label className="block text-sm font-medium text-ink-700" htmlFor="extend-reason">
                Why is it being extended?
              </label>
              <textarea id="extend-reason" name="reason" required rows={2} minLength={3}
                        className={`mt-1 ${FIELD}`}
                        placeholder="Renewal agreed with the tenant on …" />
            </div>
            <Button type="submit" variant="primary" disabled={extending}>
              {extending ? 'Extending…' : 'Extend lease'}
            </Button>
          </form>
        </Card>
      ) : null}

      {open === 'end' && !ended ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <form action={termAction} className="space-y-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="leaseId" value={leaseId} />
            {termState && !termState.ok ? (
              <div>
                <ErrorState title="Could not end this lease" detail={termState.message}
                            correlationId={termState.correlationId} />
                <FieldErrors errors={termState.fieldErrors} />
              </div>
            ) : null}
            <p className="text-sm text-ink-700">
              Ending the lease does not clear what is owed. Charges already posted stay posted, and
              any balance remains payable. The deposit is handled on its own register.
            </p>
            <DateField name="effectiveDate" label="Last day of the lease" required />
            <div>
              <label className="block text-sm font-medium text-ink-700" htmlFor="end-reason">
                Why is it ending?
              </label>
              <textarea id="end-reason" name="reason" required rows={2} minLength={3}
                        className={`mt-1 ${FIELD}`}
                        placeholder="Tenant gave notice on …, or agreement reached on …" />
            </div>
            <Button type="submit" variant="primary" disabled={terminating}>
              {terminating ? 'Ending…' : 'End the lease'}
            </Button>
          </form>
        </Card>
      ) : null}

      {events.length === 0 ? (
        <p className="text-sm text-ink-500">
          This lease has not been extended or ended. Any change to its term is recorded here with
          the reason given.
        </p>
      ) : (
        <Card className="divide-y divide-ink-100 p-0">
          {events.map((e) => (
            <div key={e.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={e.kind === 'terminated' ? 'caution' : 'info'}>
                  {e.kind === 'terminated' ? 'Ended' : 'Extended'}
                </StatusBadge>
                <span className="text-sm text-ink-900">
                  {e.kind === 'terminated' ? 'Last day' : 'Now ends'} {e.effectiveDateDisplay}
                </span>
                {e.previousEndDateDisplay ? (
                  <span className="text-xs text-ink-500">
                    was {e.previousEndDateDisplay}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{e.reason}</p>
              <p className="mt-1 text-xs text-ink-400">
                Recorded {e.recordedAtDisplay}{e.recordedBy ? ` by ${e.recordedBy}` : ''}
              </p>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
