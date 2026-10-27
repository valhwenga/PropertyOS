'use client';

import { useActionState, useState } from 'react';
import { Button, Card, EmptyState, StatusBadge } from '@propertyos/ui';
import { approveRecoveryAction, declineRecoveryAction } from './actions';

/**
 * Colleagues asking for a way back into their own accounts.
 *
 * This is the normal route, and it is here rather than with Spike on purpose:
 * the person who can tell whether this is really Thandiwe is the colleague who
 * works with her. Spike never sees these at all while somebody here can decide
 * them.
 *
 * Approving produces a link and shows it here, once. Nothing emails it: the
 * approver hands it over the way they already hand over a staff invitation —
 * and by a channel they chose, which is exactly what makes it worth anything.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

const LOST: Record<string, string> = {
  password: 'Forgotten password',
  second_factor: 'Lost authenticator',
  both: 'Forgotten password and lost authenticator',
};

export interface RecoveryRow {
  id: string;
  email: string;
  personName: string | null;
  lost: string;
  note: string | null;
  createdAt: string;
  status: string;
  live: boolean;
  effectiveAt: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
}

export function RecoveryRequests({
  slug, requests, baseUrl,
}: { slug: string; requests: RecoveryRow[]; baseUrl: string }) {
  if (requests.length === 0) {
    return (
      <EmptyState
        title="Nobody is locked out"
        description="When a colleague cannot sign in, what they ask for appears here for you to confirm."
      />
    );
  }
  return (
    <div className="space-y-3">
      {requests.map((request) => (
        <RecoveryRequest key={request.id} slug={slug} request={request} baseUrl={baseUrl} />
      ))}
    </div>
  );
}

function RecoveryRequest({
  slug, request, baseUrl,
}: { slug: string; request: RecoveryRow; baseUrl: string }) {
  const [approved, approve, approving] = useActionState(approveRecoveryAction, null);
  const [declined, decline, declining] = useActionState(declineRecoveryAction, null);
  const [open, setOpen] = useState<'approve' | 'decline' | null>(null);

  const issued = approved?.ok
    ? (approved as unknown as { token: string; tokenExpiresAt: string })
    : null;

  const hidden = (
    <>
      <input type="hidden" name="requestId" value={request.id} />
      <input type="hidden" name="slug" value={slug} />
    </>
  );

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            {request.personName ?? request.email}
          </p>
          <p className="text-xs text-ink-500">
            {request.email} · {LOST[request.lost] ?? request.lost} · asked{' '}
            {request.createdAt.slice(0, 16).replace('T', ' ')}
          </p>
        </div>
        <StatusBadge
          tone={request.status === 'open' ? 'caution' : 'positive'}
          glyph={request.status === 'open' ? '◐' : '●'}
        >
          {request.status === 'open' ? 'needs you' : request.status}
        </StatusBadge>
      </div>

      {request.note ? (
        <p className="mt-2 rounded-lg border border-ink-200 bg-ink-50 p-2 text-sm text-ink-700">
          “{request.note}”
        </p>
      ) : null}

      {request.decisionReason ? (
        <p className="mt-2 text-xs text-ink-500">
          {request.decidedByName}: {request.decisionReason}
        </p>
      ) : null}

      {issued ? (
        <div className="mt-3 rounded-lg border border-positive-600/30 bg-positive-50 p-3">
          <p className="text-sm font-semibold text-ink-900">Send them this link</p>
          <p data-recovery-link className="tabular mt-1 break-all text-xs text-ink-700">
            {baseUrl}/recover/{issued.token}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Shown once and not stored. It works once, expires in seven days, and does only
            what they said they had lost. Send it by a route you trust — ring them, or hand
            it over in person — and not to an address somebody else could be reading.
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

      {request.status === 'open' && !issued ? (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-ink-100 pt-3">
          <button
            type="button" onClick={() => setOpen(open === 'approve' ? null : 'approve')}
            className="text-sm font-medium text-spike-600 hover:underline"
          >
            {open === 'approve' ? 'Cancel' : 'It is really them'}
          </button>
          <button
            type="button" onClick={() => setOpen(open === 'decline' ? null : 'decline')}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {open === 'decline' ? 'Cancel' : 'Decline'}
          </button>
        </div>
      ) : null}

      {open === 'approve' ? (
        <form action={approve} className="mt-2 space-y-2">
          {hidden}
          <p className="text-xs text-ink-500">
            Confirm it is them by a route that is not the account you are about to unlock —
            ring the number you already have for them, or ask them in person. An email from
            their address proves only that somebody can read their email.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-60 flex-1">
              <label className="block text-sm font-medium text-ink-700" htmlFor={`why-${request.id}`}>
                How you know it is them
              </label>
              <input
                id={`why-${request.id}`} name="reason" required minLength={5} maxLength={500}
                placeholder="Rang her on the number we have and she described the new phone"
                className={`mt-1 ${FIELD}`}
              />
            </div>
            <Button type="submit" variant="primary" disabled={approving}>
              {approving ? 'Approving…' : 'Approve and make a link'}
            </Button>
          </div>
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
              placeholder="Could not reach her on the number we hold"
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
