'use client';

import { useActionState } from 'react';
import { formatDayMonthYear } from '@propertyos/domain/dates';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { DateField } from '@/components/date-field';
import { FieldErrors } from '@/components/field-errors';
import { activateLeaseAction } from './lifecycle/actions';

/**
 * Turning a draft into a tenancy.
 *
 * `activateLease` has existed since the first milestone with no screen
 * anywhere in this application, so a lease drafted in the product stayed a
 * draft for ever: no rent schedule, nothing for the billing run to find, no
 * occupancy, and a unit left unreserved. Every lease ever billed here was
 * activated by the seed script or by a test.
 *
 * It sits at the top of the lease, outside the tabs, because for a draft it is
 * the only thing on the page that matters — the version of this that lived
 * inside the "history" tab was correct and nobody would ever have found it.
 */

export interface ExecutedDocumentChoice {
  id: string;
  label: string;
}

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export function ActivationPanel({
  org, leaseId, status, version, startDate, documents,
}: {
  org: string; leaseId: string; status: string; version: number;
  /**
   * The lease's start date as ISO. `DateField` formats it to dd/mm/yyyy
   * itself; handing it an already-formatted string left the field EMPTY and
   * `required`, so the browser silently blocked the submit and the screen
   * looked like a button that did nothing. Found in the browser test.
   */
  startDate: string;
  documents: ExecutedDocumentChoice[];
}) {
  const [actState, actAction, activating] = useActionState(activateLeaseAction, null);

  return (
      <Card className="border-info-700/25 bg-info-50 p-4">
        <h2 className="text-sm font-semibold text-ink-900">
          This lease is a {status === 'draft' ? 'draft' : 'contract awaiting execution'}
        </h2>
        <p className="mt-1 text-sm text-ink-700">
          Nothing is billed and nothing is reserved until it is activated. Activating it
          reserves the unit for the term, creates the monthly rent schedule the billing run
          uses, and records the tenant as occupying the unit from the date you give.
        </p>
        <form action={actAction} className="mt-3 space-y-3">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="leaseId" value={leaseId} />
          {/* Compare-and-swap: two people activating the same draft from two
              tabs must not both succeed. */}
          <input type="hidden" name="expectedVersion" value={version} />

          {actState && !actState.ok ? (
            <div>
              <ErrorState
                title="Could not activate this lease"
                detail={actState.message ?? 'Nothing was changed.'}
                correlationId={actState.correlationId}
              />
              <FieldErrors errors={actState.fieldErrors} />
            </div>
          ) : null}

          <DateField
            name="activationDate"
            label="Active from"
            required
            value={startDate}
            hint={`The lease term starts ${formatDayMonthYear(startDate)}. Rent is billed from this date and occupancy is recorded from it.`}
          />

          <div>
            <label
              className="block text-sm font-medium text-ink-700"
              htmlFor="executedDocumentId"
            >
              The signed lease
            </label>
            <select
              id="executedDocumentId"
              name="executedDocumentId"
              className={`mt-1 ${FIELD}`}
              defaultValue=""
            >
              <option value="">Not attached — I will say why below</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-500">
              {documents.length === 0
                ? 'No document is on file for this lease yet. Upload the signed copy under '
                  + 'Documents, or activate with a reason and attach it later.'
                : 'Documents already on file for this lease. A quarantined file is not offered.'}
            </p>
          </div>

          <div>
            <label
              className="block text-sm font-medium text-ink-700"
              htmlFor="executionExceptionReason"
            >
              Or why it is being activated without one
            </label>
            <textarea
              id="executionExceptionReason"
              name="executionExceptionReason"
              rows={2}
              className={`mt-1 ${FIELD}`}
              placeholder="Signed copy is in the post; tenant moved in on the agreed date"
            />
            <p className="mt-1 text-xs text-ink-500">
              Recorded on the lease and in its audit trail, and shown on this page
              afterwards. One of the two is required — a tenancy with neither a contract nor
              an explanation is the thing this asks about.
            </p>
          </div>

          <Button type="submit" variant="primary" disabled={activating}>
            {activating ? 'Activating…' : 'Activate this lease'}
          </Button>
        </form>
      </Card>
  );
}
