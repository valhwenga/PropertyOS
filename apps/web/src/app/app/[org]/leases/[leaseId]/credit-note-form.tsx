'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import { creditChargeAction } from './charge-actions';

/**
 * Correcting a charge that is already in the books.
 *
 * A posted document is immutable, which is the right behaviour and left
 * operators with nowhere to go: `issueCreditNote` had no screen, so an invoice
 * raised for the wrong amount could only be fixed by somebody with database
 * access. This is that screen.
 *
 * It opens only when asked, because the common case is reading the list rather
 * than correcting it, and it states what remains creditable — the limit is
 * what is LEFT after earlier notes, not the original total, so two half
 * credits cannot add up to more than the charge. The server enforces that; the
 * number here is so an operator is not guessing at it.
 */
export function CreditNoteForm({
  org, leaseId, documentId, documentNumber, category, remainingMajor, today, currencySymbol,
}: {
  org: string;
  leaseId: string;
  documentId: string;
  documentNumber: string;
  category: string | null;
  /** What may still be credited, already formatted for a form field. */
  remainingMajor: string;
  today: string;
  currencySymbol: string;
}) {
  const [state, action, pending] = useActionState(creditChargeAction, null);
  const [open, setOpen] = useState(false);

  const issued = state?.ok ? (state as unknown as { documentNumber: string }) : null;
  if (issued) {
    return (
      <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
        Credited as {issued.documentNumber}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[length:var(--text-meta)] font-medium text-spike-600 hover:underline"
      >
        Credit this
      </button>
    );
  }

  const field = `
    rounded-[var(--radius-control)] border border-ink-200 bg-surface px-2 py-1
    text-[length:var(--text-meta)] text-ink-900
  `;

  return (
    <form action={action} className="w-full space-y-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="category" value={category ?? 'adjustment'} />
      <input type="hidden" name="issueDate" value={today} />

      {state && !state.ok ? (
        <ErrorState
          title="Not credited"
          detail={state.message ?? ''}
          correlationId={state.correlationId}
        />
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[length:var(--text-meta)] text-ink-700">
          <span className="block">Credit ({currencySymbol})</span>
          <input
            name="amount"
            inputMode="decimal"
            required
            defaultValue={remainingMajor}
            className={`${field} tabular w-28`}
          />
        </label>
        <label className="min-w-[14rem] flex-1 text-[length:var(--text-meta)] text-ink-700">
          <span className="block">Why — the tenant reads this</span>
          <input
            name="reason"
            required
            minLength={5}
            maxLength={300}
            placeholder="Meter was misread"
            className={`${field} w-full`}
          />
        </label>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Crediting…' : `Credit ${documentNumber}`}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[length:var(--text-meta)] text-ink-500 hover:underline"
        >
          Cancel
        </button>
      </div>
      <p className="text-[length:var(--text-meta)] text-ink-500">
        At most {currencySymbol}{remainingMajor} remains creditable on this document. The credit
        note is its own document, and the tenant can download it.
      </p>
    </form>
  );
}
