'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import { approveRecoveryAsSpikeAction, declineRecoveryAsSpikeAction } from './actions';

/**
 * The hardest decision in this console.
 *
 * Everything else here is either metadata or something the customer authorised.
 * This puts a person into an account, and the only evidence that it was the
 * right person is what the operator types into the box.
 *
 * Three things the screen therefore does. It demands that evidence at length
 * rather than a ticket number. It states that the approval waits, and why. And
 * it gives the operator the cancel link to pass on — because the protection is
 * the account holder being able to stop it, and a link nobody delivers protects
 * nobody.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

const LOST: Record<string, string> = {
  password: 'Forgotten password',
  second_factor: 'Lost authenticator',
  both: 'Forgotten password and lost authenticator',
};

export interface SpikeRecoveryRow {
  id: string;
  email: string;
  knownAccount: boolean;
  personName: string | null;
  organisations: string[];
  lost: string;
  note: string | null;
  createdAt: string;
  status: string;
  live: boolean;
  effectiveAt: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  cancellationReason: string | null;
}

export function SpikeRecovery({
  request, baseUrl, canDecide, delayHours,
}: {
  request: SpikeRecoveryRow; baseUrl: string; canDecide: boolean; delayHours: number;
}) {
  const [approved, approve, approving] = useActionState(approveRecoveryAsSpikeAction, null);
  const [declined, decline, declining] = useActionState(declineRecoveryAsSpikeAction, null);
  const [open, setOpen] = useState<'approve' | 'decline' | null>(null);

  const issued = approved?.ok
    ? (approved as unknown as { token: string; cancelToken?: string; effectiveAt: string })
    : null;

  const hidden = <input type="hidden" name="requestId" value={request.id} />;

  return (
    <Card className="p-4" data-recovery={request.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            {request.personName ?? request.email}
          </p>
          <p className="text-xs text-ink-500">
            {request.email} · {LOST[request.lost] ?? request.lost} · asked{' '}
            {request.createdAt.slice(0, 16).replace('T', ' ')}
            {request.organisations.length > 0 ? ` · ${request.organisations.join(', ')}` : ''}
          </p>
        </div>
        <StatusBadge
          tone={!request.knownAccount ? 'neutral' : request.status === 'open' ? 'caution' : 'info'}
          glyph={!request.knownAccount ? '■' : request.status === 'open' ? '◐' : '●'}
        >
          {!request.knownAccount ? 'no such account' : request.status}
        </StatusBadge>
      </div>

      {!request.knownAccount ? (
        <p className="mt-2 text-sm text-ink-700">
          No account uses that address. There is nothing to recover — decline it, and if you
          can work out who they are, tell them which address they signed up with.
        </p>
      ) : null}

      {request.note ? (
        <p className="mt-2 rounded-lg border border-ink-200 bg-ink-50 p-2 text-sm text-ink-700">
          “{request.note}”
        </p>
      ) : null}

      {request.status === 'approved' && request.effectiveAt ? (
        <p className="mt-2 text-sm text-ink-700">
          Approved by {request.decidedByName}. The link{' '}
          {request.live ? 'is now live' : `starts working at ${request.effectiveAt.slice(0, 16).replace('T', ' ')}`}.
        </p>
      ) : null}

      {request.decisionReason ? (
        <p className="mt-2 text-xs text-ink-500">{request.decisionReason}</p>
      ) : null}
      {request.cancellationReason ? (
        <p className="mt-2 text-xs text-ink-500">{request.cancellationReason}</p>
      ) : null}

      {issued ? (
        <div className="mt-3 space-y-2 rounded-lg border border-positive-600/30 bg-positive-50 p-3">
          <p className="text-sm font-semibold text-ink-900">
            Approved. It works from {issued.effectiveAt.slice(0, 16).replace('T', ' ')}.
          </p>
          <div>
            <p className="text-xs font-medium text-ink-700">Their link</p>
            <p data-recovery-link className="tabular break-all text-xs text-ink-700">
              {baseUrl}/recover/{issued.token}
            </p>
          </div>
          {issued.cancelToken ? (
            <div>
              <p className="text-xs font-medium text-ink-700">
                The link that stops it — they must have this
              </p>
              <p data-cancel-link className="tabular break-all text-xs text-ink-700">
                {baseUrl}/recover/cancel/{issued.cancelToken}
              </p>
            </div>
          ) : null}
          <p className="text-xs text-ink-500">
            Both shown once and not stored. Send them to the address on the account, and tell
            them by voice as well — the wait only protects them if they know it is running.
          </p>
        </div>
      ) : null}

      {[approved, declined].map((outcome, index) =>
        outcome && !outcome.ok ? (
          <div
            key={index}
            className="mt-2 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2"
          >
            <p className="text-sm text-critical-700">{outcome.message}</p>
          </div>
        ) : null)}

      {canDecide && request.status === 'open' && !issued ? (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-ink-100 pt-3">
          {request.knownAccount ? (
            <button
              type="button" onClick={() => setOpen(open === 'approve' ? null : 'approve')}
              className="text-sm font-medium text-spike-600 hover:underline"
            >
              {open === 'approve' ? 'Cancel' : 'Approve a recovery'}
            </button>
          ) : null}
          <button
            type="button" onClick={() => setOpen(open === 'decline' ? null : 'decline')}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {open === 'decline' ? 'Cancel' : 'Decline'}
          </button>
        </div>
      ) : null}

      {open === 'approve' ? (
        <form action={approve} className="mt-3 space-y-2 rounded-lg border border-caution-700/30 bg-caution-50 p-3">
          {hidden}
          <p className="text-sm font-semibold text-caution-700">
            This is a takeover unless you are sure.
          </p>
          <p className="text-xs text-ink-700">
            Nobody at this customer can vouch for them, which is why it is yours to decide.
            Establish who you are talking to by something that is not the account: ring the
            number on the account rather than one they give you now, and ask about things
            only they would know — the last invoice total, a property address, when they
            last paid.
          </p>
          <p className="text-xs text-ink-700">
            It takes effect in {delayHours} hour{delayHours === 1 ? '' : 's'}, and they can
            stop it until then. Send them the cancel link and tell them it is running.
          </p>
          <div>
            <label className="block text-sm font-medium text-ink-700" htmlFor={`why-${request.id}`}>
              What you checked, and against what
            </label>
            <textarea
              id={`why-${request.id}`} name="reason" required minLength={20} maxLength={500}
              rows={3}
              placeholder="Rang 082 555 0101, the number on the account since March. Confirmed the February invoice total (R4 312,50) and the Karoo street address. SPK-7205."
              className={`mt-1 ${FIELD}`}
            />
            <p className="mt-1 text-xs text-ink-500">
              Kept for as long as the account exists, against your name.
            </p>
          </div>
          <Button type="submit" variant="danger" disabled={approving}>
            {approving ? 'Approving…' : 'Approve, with a wait'}
          </Button>
        </form>
      ) : null}

      {open === 'decline' ? (
        <form action={decline} className="mt-2 flex flex-wrap items-end gap-2">
          {hidden}
          <div className="min-w-60 flex-1">
            <label className="block text-sm font-medium text-ink-700" htmlFor={`no-${request.id}`}>
              Why not
            </label>
            <input
              id={`no-${request.id}`} name="reason" required minLength={5} maxLength={500}
              placeholder="Could not reach them on the number on the account"
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <Button type="submit" variant="danger" disabled={declining}>
            {declining ? 'Declining…' : 'Decline'}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
