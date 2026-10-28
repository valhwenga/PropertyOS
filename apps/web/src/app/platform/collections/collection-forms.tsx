'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import {
  abandonCollectionAction, prepareCollectionsAction, submitCollectionAction,
} from './actions';

/**
 * The debit order run.
 *
 * Preparing and submitting are two buttons on purpose. Preparing is arithmetic
 * and can be done again; submitting takes money out of somebody's account. A
 * single "run the collections" button would mean the first bug in the
 * arithmetic is discovered by the customers it debited.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export interface CollectionRow {
  id: string;
  organisationName: string;
  invoiceNumber: string;
  reference: string;
  amount: string;
  amountMinor: number;
  actionDate: string;
  status: 'prepared' | 'submitted' | 'successful' | 'unpaid' | 'disputed' | 'abandoned';
  accountNumberLast4: string;
  providerReference: string | null;
  unpaidReason: string | null;
  disputeReason: string | null;
  abandonedReason: string | null;
}

const TONE: Record<CollectionRow['status'], { tone: 'positive' | 'critical' | 'caution' | 'info' | 'neutral'; glyph: string }> = {
  prepared: { tone: 'info', glyph: '◐' },
  submitted: { tone: 'caution', glyph: '◐' },
  successful: { tone: 'positive', glyph: '●' },
  unpaid: { tone: 'critical', glyph: '▲' },
  disputed: { tone: 'critical', glyph: '▲' },
  abandoned: { tone: 'neutral', glyph: '■' },
};

export function PrepareRunForm({ defaultDate }: { defaultDate: string }) {
  const [state, action, pending] = useActionState(prepareCollectionsAction, null);
  const run = state?.ok
    ? (state as unknown as {
      actionDate: string; totalMinor: number;
      prepared: Array<{ organisationName: string; invoiceNumber: string; amountMinor: number }>;
      skipped: Array<{ organisationName: string; invoiceNumber: string; reason: string }>;
    })
    : null;

  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-sm font-semibold text-ink-900">Prepare a run</h2>
      <p className="text-sm text-ink-500">
        Works out what is outstanding for every customer with a live mandate, and prepares one
        instruction each. Nothing leaves until you submit it.
      </p>

      <form action={action} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-sm font-medium text-ink-700" htmlFor="actionDate">
            Collection date
          </label>
          <input
            id="actionDate" name="actionDate" type="date" required defaultValue={defaultDate}
            className={`mt-1 ${FIELD}`}
          />
          <p className="mt-1 text-xs text-ink-500">The day the money would be taken.</p>
        </div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Working it out…' : 'Prepare'}
        </Button>
      </form>

      {state && !state.ok ? (
        <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{state.message}</p>
        </div>
      ) : null}

      {run ? (
        <div className="space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
          <p className="text-sm font-medium text-ink-900">
            {run.prepared.length} prepared for {run.actionDate}
          </p>
          {run.skipped.length > 0 ? (
            <>
              <p className="text-sm text-ink-700">
                {run.skipped.length} not collected, and why:
              </p>
              <ul className="space-y-0.5">
                {run.skipped.map((s) => (
                  <li key={`${s.organisationName}-${s.invoiceNumber}`} className="text-xs text-ink-700">
                    <span className="font-medium">{s.organisationName}</span> ({s.invoiceNumber})
                    — {s.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function CollectionCard({
  collection, sandbox,
}: { collection: CollectionRow; sandbox: boolean }) {
  const [submitted, submit, submitting] = useActionState(submitCollectionAction, null);
  const [abandoned, abandon, abandoning] = useActionState(abandonCollectionAction, null);
  const [open, setOpen] = useState(false);
  const tone = TONE[collection.status];

  return (
    <Card className="p-4" data-collection={collection.reference}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            {collection.organisationName}
            <span className="ml-2 font-normal text-ink-500">{collection.invoiceNumber}</span>
          </p>
          <p className="text-xs text-ink-500">
            <span className="tabular">{collection.amount}</span> on {collection.actionDate} ·
            account ending <span className="tabular">{collection.accountNumberLast4}</span> ·{' '}
            <span className="tabular">{collection.reference}</span>
          </p>
        </div>
        <StatusBadge tone={tone.tone} glyph={tone.glyph}>{collection.status}</StatusBadge>
      </div>

      {collection.unpaidReason ? (
        <p className="mt-2 text-sm text-critical-700">
          The bank did not pay it: {collection.unpaidReason}
        </p>
      ) : null}
      {collection.disputeReason ? (
        <p className="mt-2 text-sm text-critical-700">
          Disputed and reversed: {collection.disputeReason}. The invoice owes it again.
        </p>
      ) : null}
      {collection.abandonedReason ? (
        <p className="mt-2 text-xs text-ink-500">{collection.abandonedReason}</p>
      ) : null}

      {[submitted, abandoned].map((outcome, index) =>
        outcome && !outcome.ok ? (
          <div key={index} className="mt-2 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{outcome.message}</p>
          </div>
        ) : null)}

      {collection.status === 'prepared' ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3">
          <form action={submit}>
            <input type="hidden" name="collectionId" value={collection.id} />
            <Button type="submit" variant="danger" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit to the bank'}
            </Button>
          </form>
          <button
            type="button" onClick={() => setOpen((shown) => !shown)}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {open ? 'Keep it' : 'Do not collect this'}
          </button>
        </div>
      ) : null}

      {collection.status === 'submitted' && sandbox ? (
        <p className="mt-3 border-t border-ink-100 pt-3 text-xs text-ink-500">
          With the sandbox &ldquo;bank&rdquo;. A real answer arrives on its own, days later;{' '}
          <a
            href={`/pay/sandbox/collection/${collection.reference}?amount=${collection.amountMinor}`}
            className="font-medium text-spike-600 underline underline-offset-2"
          >
            produce one now
          </a>
          .
        </p>
      ) : null}

      {collection.status === 'unpaid' ? (
        <div className="mt-3 border-t border-ink-100 pt-3">
          <button
            type="button" onClick={() => setOpen((shown) => !shown)}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {open ? 'Keep it' : 'Give up on this one'}
          </button>
        </div>
      ) : null}

      {open ? (
        <form action={abandon} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="collectionId" value={collection.id} />
          <div className="min-w-60 flex-1">
            <label className="block text-sm font-medium text-ink-700" htmlFor={`why-${collection.id}`}>
              Why it is not being collected
            </label>
            <input
              id={`why-${collection.id}`} name="reason" required minLength={5} maxLength={500}
              placeholder="They paid by transfer on the 3rd"
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <Button type="submit" variant="danger" disabled={abandoning}>
            {abandoning ? 'Saving…' : 'Do not collect it'}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
