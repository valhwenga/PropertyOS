'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import { markReadyAction, sendReadyAction, withdrawAction } from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

/**
 * Choosing which invoices go out.
 *
 * The checkboxes are inside this form, so "Mark ready" carries exactly what is
 * ticked. Nothing is pre-ticked: a bulk action over somebody else's money
 * should start from nothing selected, not from everything.
 */
export function MarkReadyForm({
  org, invoices,
}: {
  org: string;
  invoices: Array<{ documentId: string; label: string; detail: string; amount: string }>;
}) {
  const [state, action, pending] = useActionState(markReadyAction, null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setChosen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // The confirmation lives outside the list, because marking the last invoice
  // empties the list: a success message inside it would vanish at the exact
  // moment it was earned, leaving an operator unsure whether anything happened.
  const outcome = (
    <>
      <Problem state={state} title="Could not mark these ready" />
      {state?.ok ? (
        <p className="text-[length:var(--text-meta)] font-medium text-positive-600">
          {'marked' in state && Number(state.marked) > 0
            ? `${state.marked} marked ready. Nothing has been sent yet — that is the next step.`
            : 'Nothing was marked.'}
          {'alreadySent' in state && (state.alreadySent as string[]).length > 0
            ? ` ${(state.alreadySent as string[]).join(', ')} had already been sent and `
              + 'will not be sent again.'
            : ''}
        </p>
      ) : null}
    </>
  );

  if (invoices.length === 0) {
    return (
      <div className="space-y-2 px-4 py-5 text-center">
        {outcome}
        <p className="text-[length:var(--text-table)] text-ink-500">
          Every posted invoice in this period has been dealt with.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 p-4">
      <input type="hidden" name="org" value={org} />
      {outcome}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setChosen((was) => (was.size === invoices.length
            ? new Set()
            : new Set(invoices.map((i) => i.documentId))))}
          className="text-[length:var(--text-meta)] font-medium text-spike-600 hover:underline"
        >
          {chosen.size === invoices.length ? 'Clear the selection' : `Select all ${invoices.length}`}
        </button>
        <span className="text-[length:var(--text-meta)] text-ink-500">
          {chosen.size} selected
        </span>
      </div>

      <ul className="divide-y divide-ink-100 rounded-[var(--radius-control)] border border-ink-100">
        {invoices.map((invoice) => (
          <li key={invoice.documentId}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-ink-50">
              <input
                type="checkbox"
                name="documentId"
                value={invoice.documentId}
                checked={chosen.has(invoice.documentId)}
                onChange={() => toggle(invoice.documentId)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[length:var(--text-table)] font-medium text-ink-900">
                  {invoice.label}
                </span>
                <span className="block text-[length:var(--text-meta)] text-ink-500">
                  {invoice.detail}
                </span>
              </span>
              <span className="tabular shrink-0 text-[length:var(--text-table)] font-semibold text-ink-900">
                {invoice.amount}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <Button type="submit" variant="secondary" disabled={pending || chosen.size === 0}>
        {pending ? 'Marking…' : `Mark ${chosen.size || ''} ready to send`.trim()}
      </Button>
    </form>
  );
}

/**
 * Sending everything that is ready.
 *
 * Behind a confirmation, because it writes to every resident in the list at
 * once and there is no unsending. The confirmation says how many and what the
 * product will actually do with them.
 */
export function SendReadyForm({
  org, readyCount, withoutEmail, providerConfigured, providerNote,
}: {
  org: string;
  readyCount: number;
  withoutEmail: number;
  providerConfigured: boolean;
  providerNote: string;
}) {
  const [state, action, pending] = useActionState(sendReadyAction, null);
  const [confirming, setConfirming] = useState(false);

  const queued = state?.ok && 'queued' in state ? Number(state.queued) : null;
  const suppressed = state?.ok && 'suppressed' in state
    ? (state.suppressed as Array<{ documentNumber: string; reason: string }>)
    : [];

  if (queued !== null) {
    return (
      <div className="space-y-2 p-4">
        <p className="text-[length:var(--text-table)] font-semibold text-ink-900">
          {queued === 0
            ? 'Nothing was queued.'
            : `${queued} message${queued === 1 ? '' : 's'} queued for sending.`}
        </p>
        <p className="text-[length:var(--text-table)] text-ink-700">
          {providerConfigured
            ? 'The worker is sending them now. Each invoice below will show what the provider '
              + 'answered — a message is only marked sent once the provider accepts it.'
            : providerNote}
        </p>
        {suppressed.length > 0 ? (
          <div className="rounded-[var(--radius-control)] border border-caution-700/25 bg-caution-50 px-3 py-2">
            <p className="text-[length:var(--text-table)] font-semibold text-caution-700">
              {suppressed.length} could not be addressed
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[length:var(--text-table)] text-ink-700">
              {suppressed.map((s) => (
                <li key={s.documentNumber}>{s.documentNumber} — {s.reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="space-y-2 p-4">
        <Problem state={state} title="Could not send" />
        <Button
          type="button"
          variant="primary"
          disabled={readyCount === 0}
          onClick={() => setConfirming(true)}
        >
          {readyCount === 0
            ? 'Nothing is ready to send'
            : `Send all ${readyCount} ready invoice${readyCount === 1 ? '' : 's'}`}
        </Button>
        {withoutEmail > 0 ? (
          <p className="text-[length:var(--text-meta)] text-caution-700">
            {withoutEmail} of them {withoutEmail === 1 ? 'has' : 'have'} no email address on file
            and cannot be sent. They will be listed rather than skipped.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 p-4">
      <input type="hidden" name="org" value={org} />
      <Problem state={state} title="Could not send" />
      <p className="text-[length:var(--text-table)] text-ink-700">
        This writes to <strong>{readyCount}</strong> resident{readyCount === 1 ? '' : 's'} in your
        organisation&rsquo;s name, using the message set under Settings. There is no unsending.
      </p>
      {!providerConfigured ? (
        <p className="rounded-[var(--radius-control)] border border-caution-700/25 bg-caution-50 px-3 py-2 text-[length:var(--text-table)] text-ink-700">
          {providerNote}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Queueing…' : 'Yes, send them'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Trying again after a delivery that did not happen.
 *
 * The reason an outcome is recorded rather than swallowed: somebody fixes the
 * address, or the provider, and sends it again. Without this an operator reads
 * "not delivered" on four invoices and has nothing to press.
 */
export function RetryForm({ org, documentId }: { org: string; documentId: string }) {
  const [state, action, pending] = useActionState(markReadyAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="documentId" value={documentId} />
      <button
        type="submit"
        disabled={pending}
        title={state && !state.ok ? state.message : undefined}
        className="text-[length:var(--text-meta)] font-medium text-spike-600 hover:underline"
      >
        {pending ? 'Marking…' : 'Try again'}
      </button>
    </form>
  );
}

/** Taking one back out of the pile before anything is sent. */
export function WithdrawForm({ org, documentId }: { org: string; documentId: string }) {
  const [state, action, pending] = useActionState(withdrawAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="documentId" value={documentId} />
      <button
        type="submit"
        disabled={pending}
        title={state && !state.ok ? state.message : undefined}
        className="text-[length:var(--text-meta)] font-medium text-ink-500 hover:text-ink-900 hover:underline"
      >
        {pending ? 'Removing…' : 'Take out'}
      </button>
    </form>
  );
}
