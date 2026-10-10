'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { recordReceiptAction, reviewEvidenceAction } from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title = 'Not saved' }: { state: Outcome | null; title?: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

/**
 * Recording money that actually arrived.
 *
 * The one thing this form must never become is a way to turn a resident's claim
 * into a balance. It asks for funds the operator has seen in the account, and
 * says so. Leaving the payer blank is a first-class choice, not an omission:
 * unidentified money belongs in suspense, not on a guessed lease.
 */
export function RecordReceiptForm({
  org, leases, today, prefill,
}: {
  org: string; today: string;
  leases: { id: string; reference: string; label: string }[];
  /**
   * Filled in when the operator arrived from a statement line.
   *
   * The amount and the date come from the bank, so they are not retyped; the
   * lease is only a default, because which lease it is remains their decision
   * and a suggestion that fills itself in is a decision made by the product.
   */
  prefill?: {
    leaseId?: string; amountMajor?: string; receivedOn?: string;
    payerReference?: string; bankTransactionId?: string;
  };
}) {
  const [state, action, pending] = useActionState(recordReceiptAction, null);
  const [open, setOpen] = useState(Boolean(prefill));

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)}>
        Record money received
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        {prefill?.bankTransactionId ? (
          <input type="hidden" name="bankTransactionId" value={prefill.bankTransactionId} />
        ) : null}
        <h2 className="text-sm font-semibold text-ink-900">Record money received</h2>
        <p className="text-sm text-ink-500">
          For funds you have confirmed are in the bank account. A resident&rsquo;s proof of
          payment is not this: it is reviewed separately and changes no balance.
        </p>
        {prefill?.bankTransactionId ? (
          <p className="text-sm text-ink-700">
            Started from a statement line, so the amount and date come from the bank. The lease
            below is a suggestion — check it before recording, because this is the moment the
            money lands on somebody&rsquo;s account.
          </p>
        ) : null}

        <Problem state={state} />
        {state?.ok ? (
          <p className="text-sm font-semibold text-positive-600">
            Receipt recorded.{' '}
            {'inSuspense' in state && state.inSuspense
              ? 'It is in suspense until you say whose it is.'
              : 'Open it to apply the money to charges.'}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="amount" className="block text-sm font-medium text-ink-700">
              Amount received
            </label>
            <input
              id="amount" name="amount" inputMode="decimal" required placeholder="8000.00"
              defaultValue={prefill?.amountMajor ?? ''}
              className="tabular w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
            <p className="text-xs text-ink-500">
              The gross amount that reached the account, before any processing fee.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="receivedOn" className="block text-sm font-medium text-ink-700">
              Date received
            </label>
            <input
              id="receivedOn" name="receivedOn" type="date" required
              defaultValue={prefill?.receivedOn ?? today}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="receiptLeaseId" className="block text-sm font-medium text-ink-700">
              Whose payment is this?
            </label>
            <select
              id="receiptLeaseId" name="leaseId" defaultValue={prefill?.leaseId ?? ''}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="">Not identified — hold in suspense</option>
              {leases.map((l) => (
                <option key={l.id} value={l.id}>{l.reference} — {l.label}</option>
              ))}
            </select>
            <p className="text-xs text-ink-500">
              Leave it unidentified if you are not sure. Guessing is worse than suspense.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="method" className="block text-sm font-medium text-ink-700">How</label>
            <select
              id="method" name="method"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="eft">EFT</option>
              <option value="cash">Cash</option>
              <option value="debit_order">Debit order</option>
              <option value="card">Card</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="payerReference" className="block text-sm font-medium text-ink-700">
              Reference on the statement
            </label>
            <input
              id="payerReference" name="payerReference" placeholder="MOKOENA T"
              defaultValue={prefill?.payerReference ?? ''}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="fee" className="block text-sm font-medium text-ink-700">
              Processing fee, if any
            </label>
            <input
              id="fee" name="fee" inputMode="decimal" placeholder="0.00"
              className="tabular w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
            <p className="text-xs text-ink-500">
              Recorded separately. A R8,000 payment with a R120 fee still pays R8,000 of rent.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="notes" className="block text-sm font-medium text-ink-700">Notes</label>
          <input
            id="notes" name="notes"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Recording…' : 'Record receipt'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Close</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Reviewing a resident's proof of payment.
 *
 * Accepting a claim records a judgement. It creates no receipt, posts no
 * journal and moves no balance — only money confirmed in the account does that.
 * The form says so, because an operator who believes otherwise will tell a
 * resident their account is settled when it is not.
 */
export function ReviewEvidenceForm({
  org, evidenceId, leaseReference,
}: {
  org: string; evidenceId: string; leaseReference: string | null;
}) {
  const [state, action, pending] = useActionState(reviewEvidenceAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Review</Button>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="evidenceId" value={evidenceId} />
      <Problem state={state} title="Could not record the review" />

      <p className="text-xs text-ink-700">
        This records a decision only. It does not reduce what the resident owes, whichever
        outcome you choose — that happens when the money is confirmed in the account and
        recorded as a receipt.
        {leaseReference ? (
          <>
            {' '}
            <Link
              href={`/app/${org}/reconciliation`}
              className="font-medium text-spike-600 hover:underline"
            >
              Record it against {leaseReference}
            </Link>{' '}
            once you see it on the statement.
          </>
        ) : null}
      </p>

      <div className="space-y-1.5">
        <label htmlFor={`outcome-${evidenceId}`} className="block text-sm font-medium text-ink-700">
          Outcome
        </label>
        <select
          id={`outcome-${evidenceId}`} name="outcome" required
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        >
          <option value="under_review">Still checking</option>
          <option value="accepted">Looks genuine</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`note-${evidenceId}`} className="block text-sm font-medium text-ink-700">
          Note
        </label>
        <input
          id={`note-${evidenceId}`} name="note"
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
        <p className="text-xs text-ink-500">Required when rejecting. The resident is told why.</p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Record the review'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
