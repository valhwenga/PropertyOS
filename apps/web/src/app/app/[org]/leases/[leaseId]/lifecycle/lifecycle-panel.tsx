'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import { DateField } from '@/components/date-field';
import { DeliveryNote } from '@/components/delivery-note';
import { FieldErrors } from '@/components/field-errors';
import {
  expireLeaseAction, extendLeaseAction, renewLeaseAction, terminateLeaseAction,
} from './actions';

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
 * The day after an ISO date, as the natural start of a renewal.
 *
 * Done on the UTC calendar rather than with a local Date, so the suggestion
 * does not shift by a day for somebody whose browser is west of Greenwich.
 */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Ending or extending the lease, and the record of both.
 *
 * The reason is required by the database, not just by this form: the history
 * row and the change to the lease are written in one transaction, so a lease
 * cannot end without someone saying why.
 */
export function LifecyclePanel({
  org, leaseId, status, endDateDisplay, events, endDate, termEnded, rentMajor, suggestedEnd,
}: {
  org: string; leaseId: string; status: string; endDateDisplay: string | null;
  events: LifecycleEvent[];
  /** ISO. `DateField` formats it; a display string leaves the field empty. */
  endDate: string | null;
  /** Whether the end date has passed, which is when expiring is the honest option. */
  termEnded: boolean;
  /** The current rent in major units, as a renewal's starting point. */
  rentMajor: string;
  /** A year after the new term starts, as ISO. */
  suggestedEnd: string | null;
}) {
  const [termState, termAction, terminating] = useActionState(terminateLeaseAction, null);
  const [extState, extAction, extending] = useActionState(extendLeaseAction, null);
  const [expState, expAction, expiring] = useActionState(expireLeaseAction, null);
  const [renState, renAction, renewing] = useActionState(renewLeaseAction, null);
  const [open, setOpen] = useState<'none' | 'end' | 'extend' | 'expire' | 'renew'>('none');
  const ended = status === 'closed' || status === 'cancelled';
  const expired = status === 'expired';

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Term changes
        </h2>
        {ended ? (
          <StatusBadge tone="neutral">This lease has ended</StatusBadge>
        ) : (
          <div className="flex flex-wrap gap-2">
            {expired ? null : (
              <button type="button" onClick={() => setOpen(open === 'extend' ? 'none' : 'extend')}
                      className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
                Extend
              </button>
            )}
            <button type="button" onClick={() => setOpen(open === 'renew' ? 'none' : 'renew')}
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
              Renew for a new term
            </button>
            {/* Offered once the term has actually run out. On a lease with
                months to run, ending early is `terminate` with a reason, and
                calling that "expired" would record something that did not
                happen. */}
            {termEnded && !expired ? (
              <button type="button" onClick={() => setOpen(open === 'expire' ? 'none' : 'expire')}
                      className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
                The term has ended
              </button>
            ) : null}
            {expired ? null : (
              <button type="button" onClick={() => setOpen(open === 'end' ? 'none' : 'end')}
                      className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700">
                End the lease
              </button>
            )}
          </div>
        )}
      </div>

      {/* Who was told, and whether the email actually went out. This sits outside
          both forms on purpose: ending a lease closes it, which hides the form,
          and the operator still needs to see what reached the resident. */}
      {termState?.ok ? (
        <DeliveryNote
          inbox={termState.inbox} email={termState.email} emailDetail={termState.emailDetail}
          overrodePreference={termState.overrodePreference}
          nobody="The lease has ended. Nobody on it has a portal account, so no notice was sent."
        />
      ) : null}
      {extState?.ok ? (
        <DeliveryNote
          inbox={extState.inbox} email={extState.email} emailDetail={extState.emailDetail}
          nobody="The lease has been extended. Nobody on it has a portal account, so no notice was sent."
        />
      ) : null}

      {termEnded && !expired && !ended && open === 'none' ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            This lease's term ended {endDateDisplay}, and it is still recorded as {status}
          </p>
          <p className="mt-1 text-sm text-ink-700">
            Nothing happens on its own: the product does not guess whether the tenant left or
            stayed on. Record which it was with <strong>The term has ended</strong>, or agree a
            new term with <strong>Renew for a new term</strong>.
          </p>
        </Card>
      ) : null}

      {open === 'renew' && !ended ? (
        <Card className="p-4">
          <form action={renAction} className="space-y-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="leaseId" value={leaseId} />
            {renState && !renState.ok ? (
              <div>
                <ErrorState title="Could not renew this lease" detail={renState.message}
                            correlationId={renState.correlationId} />
                <FieldErrors errors={renState.fieldErrors} />
              </div>
            ) : null}
            {renState?.ok ? (
              <p className="text-sm font-medium text-positive-600">
                {(renState as unknown as { reference: string }).reference} drafted for the new
                term. It is a draft: open it and activate it when the renewal is signed —
                nothing is billed and the unit is not reserved for it until you do.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-700">
                  A renewal is a new lease linked to this one. This one keeps its history and
                  its arrears; the successor starts as a <strong>draft</strong> and goes
                  through the same activation step, because a renewal is an agreement rather
                  than a number somebody typed.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DateField name="newStartDate" label="New term starts" required
                             value={endDate ? nextDay(endDate) : null}
                             hint={endDateDisplay ? `The current term ends ${endDateDisplay}.` : undefined} />
                  <DateField name="newEndDate" label="New term ends" value={suggestedEnd}
                             hint="Leave empty for a month-to-month renewal." />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="newRent">
                    Rent for the new term
                  </label>
                  <input id="newRent" name="newRent" required defaultValue={rentMajor}
                         inputMode="decimal" className={`mt-1 ${FIELD}`} />
                  <p className="mt-1 text-xs text-ink-500">
                    The current rent, as a starting point. An agreed escalation goes in here —
                    this does not apply one for you.
                  </p>
                </div>
                <Button type="submit" variant="primary" disabled={renewing}>
                  {renewing ? 'Drafting…' : 'Draft the renewal'}
                </Button>
              </>
            )}
          </form>
        </Card>
      ) : null}

      {open === 'expire' && termEnded && !expired && !ended ? (
        <Card className="p-4">
          <form action={expAction} className="space-y-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="leaseId" value={leaseId} />
            {expState && !expState.ok ? (
              <ErrorState title="Could not record the end of the term" detail={expState.message}
                          correlationId={expState.correlationId} />
            ) : null}
            <p className="text-sm text-ink-700">
              This records that the term ran out. It does not clear arrears, and it does not
              close the lease: charges already posted stay posted and any balance remains
              payable.
            </p>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-700">Has the tenant moved out?</legend>
              <label className="flex items-start gap-2 text-sm text-ink-700">
                <input type="radio" name="holdover" value="no" defaultChecked className="mt-1" />
                <span>
                  Yes, they have left. The occupancy record is closed at the end of the term.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-ink-700">
                <input type="radio" name="holdover" value="yes" className="mt-1" />
                <span>
                  No, they are still there. Recorded as a <strong>holdover</strong>: the
                  occupancy stays open and marked, because somebody living in a unit is a fact
                  and the lease running out does not change it.
                </span>
              </label>
            </fieldset>
            <Button type="submit" disabled={expiring}>
              {expiring ? 'Recording…' : 'Record the end of the term'}
            </Button>
          </form>
        </Card>
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
            <p className="text-sm text-ink-700">
              Everyone on the lease is told, by inbox and by email. A resident who asked not to be
              emailed is emailed anyway: a lease ending is not optional reading.
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
