'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, Money } from '@propertyos/ui';
import {
  applyAllocationAction, identifyReceiptAction, reverseAllocationAction,
  suggestAllocationAction,
} from '../actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title = 'Not saved' }: { state: Outcome | null; title?: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface OpenCharge {
  chargeLineId: string;
  description: string;
  category: string;
  dueDate: string;
  outstandingMinor: string;
  dueLabel: string;
}

/**
 * Applying a receipt to charges.
 *
 * Two deliberate separations. Suggesting and applying are different buttons,
 * because §9 says a suggested match is not automatically final — the suggestion
 * fills the boxes and an operator confirms or changes them. And the running
 * total is shown against what the receipt actually holds, so an operator can
 * see they are about to over-allocate before the server refuses them.
 *
 * The arithmetic below is display only. Every amount is re-parsed and
 * re-checked server side, and the database holds the row lock that makes
 * over-allocation impossible under concurrency.
 */
export function AllocateForm({
  org, receiptId, leaseId, unappliedMinor, currency, charges, today,
}: {
  org: string; receiptId: string; leaseId: string;
  unappliedMinor: string; currency: string; charges: OpenCharge[]; today: string;
}) {
  const [applyState, apply, applying] = useActionState(applyAllocationAction, null);
  const [suggestState, suggest, suggesting] = useActionState(suggestAllocationAction, null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  // Whatever the suggestion came back with wins over what is in the boxes,
  // until the operator types again.
  const suggested: Record<string, string> = {};
  if (suggestState?.ok && 'allocations' in suggestState) {
    for (const a of suggestState.allocations as { chargeLineId: string; amountMinor: string }[]) {
      suggested[a.chargeLineId] = (Number(a.amountMinor) / 100).toFixed(2);
    }
  }
  const valueFor = (id: string) => amounts[id] ?? suggested[id] ?? '';

  const typed = charges.reduce((sum, c) => {
    const raw = Number(valueFor(c.chargeLineId).replace(/[^0-9.]/g, ''));
    return sum + (Number.isFinite(raw) ? Math.round(raw * 100) : 0);
  }, 0);
  const available = Number(unappliedMinor);
  const over = typed > available;
  const remainder = available - typed;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Apply this money to charges</h2>
      <p className="mt-1 text-sm text-ink-500">
        A suggestion is not final. Change any amount before applying; whatever is left over
        stays as unapplied credit on this receipt.
      </p>

      <div className="mt-4">
        <Problem state={applyState} title="Could not apply" />
        <Problem state={suggestState} title="Could not suggest" />
        {applyState?.ok ? (
          <p className="text-sm font-semibold text-positive-600">
            Applied. {'count' in applyState ? String(applyState.count) : ''} charge
            {'count' in applyState && Number(applyState.count) === 1 ? '' : 's'} updated.
          </p>
        ) : null}
      </div>

      {/* Suggest: its own form, so asking for a suggestion can never post an
          allocation by accident. */}
      <form action={suggest} className="mt-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="leaseId" value={leaseId} />
        <input type="hidden" name="unapplied" value={(available / 100).toFixed(2)} />
        <Button type="submit" variant="secondary" disabled={suggesting}>
          {suggesting ? 'Working…' : 'Suggest — oldest due date first'}
        </Button>
        {suggestState?.ok && 'policy' in suggestState ? (
          <p className="mt-2 text-xs text-ink-500">
            Filled in using the {String(suggestState.policy).replace(/_/g, ' ')} policy.
            {Number(suggestState.remainingMinor) > 0
              ? ' There are not enough open charges to absorb all of it; the rest would stay as credit.'
              : ''}
          </p>
        ) : null}
      </form>

      <form action={apply} className="mt-5 space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="receiptId" value={receiptId} />

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Open charges on this lease</caption>
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th scope="col" className="py-2 pr-3">Charge</th>
                <th scope="col" className="py-2 pr-3">Due</th>
                <th scope="col" className="py-2 pr-3 text-right">Outstanding</th>
                <th scope="col" className="py-2 text-right">Apply</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.chargeLineId} className="border-b border-ink-100">
                  <td className="py-2 pr-3">
                    <span className="text-ink-900">{c.description}</span>
                    <span className="ml-1.5 text-xs capitalize text-ink-400">
                      {c.category.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-ink-500">{c.dueLabel}</td>
                  <td className="tabular py-2 pr-3 text-right text-ink-700">
                    <Money minor={BigInt(c.outstandingMinor)} currency={currency} />
                  </td>
                  <td className="py-2 text-right">
                    <label className="sr-only" htmlFor={`amount:${c.chargeLineId}`}>
                      Amount to apply to {c.description}
                    </label>
                    <input
                      id={`amount:${c.chargeLineId}`}
                      name={`amount:${c.chargeLineId}`}
                      inputMode="decimal"
                      value={valueFor(c.chargeLineId)}
                      onChange={(e) =>
                        setAmounts((prev) => ({ ...prev, [c.chargeLineId]: e.target.value }))}
                      className="tabular w-32 rounded-lg border border-ink-200 px-2 py-1.5 text-right text-sm"
                      placeholder="0.00"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          className={`rounded-lg border p-3 text-sm ${
            over ? 'border-critical-700/30 bg-critical-50' : 'border-ink-100 bg-ink-50'
          }`}
        >
          <div className="flex flex-wrap justify-between gap-2">
            <span className="text-ink-700">Available on this receipt</span>
            <span className="tabular font-medium">
              <Money minor={BigInt(unappliedMinor)} currency={currency} />
            </span>
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-2">
            <span className="text-ink-700">Being applied</span>
            <span className="tabular font-medium">
              <Money minor={BigInt(typed)} currency={currency} />
            </span>
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-2 border-t border-ink-200 pt-1">
            <span className="text-ink-700">
              {over ? 'Over-allocated by' : 'Left as unapplied credit'}
            </span>
            <span className="tabular font-semibold">
              <Money minor={BigInt(Math.abs(remainder))} currency={currency} />
            </span>
          </div>
          {over ? (
            <p className="mt-2 text-xs text-critical-700">
              More than this receipt holds. The server refuses this, and so does the database —
              but fix it here and save yourself the round trip.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label htmlFor="postingDate" className="block text-sm font-medium text-ink-700">
              Posting date
            </label>
            <input
              id="postingDate" name="postingDate" type="date" defaultValue={today} required
              className="rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
          <Button type="submit" variant="primary" disabled={applying || over || typed === 0}>
            {applying ? 'Applying…' : 'Apply to these charges'}
          </Button>
        </div>
        <p className="text-xs text-ink-500">
          The posting date is the business date this allocation is recorded under, which is what
          reports apply their cut-off to — not the moment you pressed the button.
        </p>
      </form>
    </Card>
  );
}

/** Says whose money a suspense receipt is, without allocating it. */
export function IdentifyForm({
  org, receiptId, leases, today,
}: {
  org: string; receiptId: string; today: string;
  leases: { id: string; reference: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(identifyReceiptAction, null);

  return (
    <Card className="border-caution-700/30 bg-caution-50 p-5">
      <h2 className="text-sm font-semibold text-caution-700">This money has no identified payer</h2>
      <p className="mt-1 text-sm text-ink-700">
        It is in suspense: real money, in the account, owed to someone. Say whose it is and it
        moves onto their lease as unapplied credit. That is a separate step from applying it to
        charges, because knowing whose money it is says nothing about what it pays for.
      </p>

      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="receiptId" value={receiptId} />
        <Problem state={state} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="leaseId" className="block text-sm font-medium text-ink-700">
              Whose payment is this?
            </label>
            <select
              id="leaseId" name="leaseId" required
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="">Choose a lease…</option>
              {leases.map((l) => (
                <option key={l.id} value={l.id}>{l.reference} — {l.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="identifyDate" className="block text-sm font-medium text-ink-700">
              Posting date
            </label>
            <input
              id="identifyDate" name="postingDate" type="date" defaultValue={today} required
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="identifyReason" className="block text-sm font-medium text-ink-700">
            How do you know?
          </label>
          <input
            id="identifyReason" name="reason" required minLength={5}
            placeholder="Matched the reference on the bank statement"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Assign to this lease'}
        </Button>
      </form>
    </Card>
  );
}

/** Undoes one allocation, leaving its history in place. */
export function ReverseForm({
  org, receiptId, allocationId, today,
}: {
  org: string; receiptId: string; allocationId: string; today: string;
}) {
  const [state, action, pending] = useActionState(reverseAllocationAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-spike-600 hover:underline"
      >
        Reverse
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-ink-200 p-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="receiptId" value={receiptId} />
      <input type="hidden" name="allocationId" value={allocationId} />
      <Problem state={state} title="Could not reverse" />
      <p className="text-xs text-ink-700">
        The money returns to unapplied credit on this receipt and the charge goes back to
        outstanding. Nothing is deleted: the original allocation and its reversal both stay.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor={`reason-${allocationId}`} className="block text-xs font-medium text-ink-700">
            Why?
          </label>
          <input
            id={`reason-${allocationId}`} name="reason" required minLength={5}
            className="w-64 rounded-lg border border-ink-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`date-${allocationId}`} className="block text-xs font-medium text-ink-700">
            Posting date
          </label>
          <input
            id={`date-${allocationId}`} name="postingDate" type="date" defaultValue={today} required
            className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Reversing…' : 'Confirm reversal'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
