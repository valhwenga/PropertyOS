'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { addCommentAction, transitionTicketAction } from './actions';

const NEXT_STATES: Record<string, string[]> = {
  submitted:             ['triaged', 'on_hold', 'cancelled'],
  triaged:               ['awaiting_approval', 'assigned', 'on_hold', 'cancelled'],
  awaiting_approval:     ['assigned', 'triaged', 'on_hold', 'cancelled'],
  assigned:              ['in_progress', 'triaged', 'on_hold', 'cancelled'],
  in_progress:           ['awaiting_confirmation', 'resolved', 'on_hold', 'cancelled'],
  awaiting_confirmation: ['resolved', 'in_progress', 'on_hold'],
  resolved:              ['closed', 'in_progress'],
  closed:                ['in_progress'],
  on_hold:               ['triaged', 'assigned', 'in_progress', 'cancelled'],
  cancelled:             [],
};

const REASON_REQUIRED = new Set(['on_hold', 'cancelled']);

export function TicketActions({
  org, ticketId, currentStatus,
}: {
  org: string; ticketId: string; currentStatus: string;
}) {
  const [transitionState, transition, transitioning] = useActionState(transitionTicketAction, null);
  const [commentState, comment, commenting] = useActionState(addCommentAction, null);
  const [target, setTarget] = useState('');
  const [audience, setAudience] = useState<'internal' | 'resident_visible' | 'contractor_visible'>('internal');

  const available = NEXT_STATES[currentStatus] ?? [];
  const needsReason = REASON_REQUIRED.has(target);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Move this request</h2>

        {transitionState && !transitionState.ok ? (
          <div className="mt-3">
            <ErrorState
              title="Could not update"
              detail={transitionState.message}
              correlationId={transitionState.correlationId}
            />
          </div>
        ) : null}

        {available.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">
            This request is cancelled. No further transitions are available.
          </p>
        ) : (
          <form action={transition} className="mt-3 space-y-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="ticketId" value={ticketId} />

            <div className="space-y-1.5">
              <label htmlFor="to" className="block text-sm font-medium text-ink-700">Next state</label>
              <select
                id="to" name="to" required value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="">Choose…</option>
                {available.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>

            {target === 'triaged' ? (
              <div className="space-y-1.5">
                <label htmlFor="triagedUrgency" className="block text-sm font-medium text-ink-700">
                  Your urgency assessment
                </label>
                <select
                  id="triagedUrgency" name="triagedUrgency"
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                >
                  <option value="">Keep as reported</option>
                  <option value="emergency">Emergency</option>
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
                <p className="text-xs text-ink-400">
                  This is recorded alongside, not instead of, what the resident reported.
                </p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="reason" className="block text-sm font-medium text-ink-700">
                {needsReason ? 'Reason (required)' : 'Note (optional)'}
              </label>
              <textarea
                id="reason" name={needsReason ? 'reason' : 'note'} rows={2}
                required={needsReason}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              />
            </div>

            <Button type="submit" variant="primary" disabled={transitioning || !target}>
              {transitioning ? 'Updating…' : 'Update request'}
            </Button>
          </form>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Add a comment</h2>

        {commentState && !commentState.ok ? (
          <div className="mt-3">
            <ErrorState
              title="Could not add comment"
              detail={commentState.message}
              correlationId={commentState.correlationId}
            />
          </div>
        ) : null}

        <form action={comment} className="mt-3 space-y-3">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="ticketId" value={ticketId} />

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-ink-700">Who can read this</legend>
            {([
              ['internal', 'Internal only — the resident and contractor never see it'],
              ['resident_visible', 'Visible to the resident'],
              ['contractor_visible', 'Visible to the assigned contractor'],
            ] as const).map(([value, label]) => (
              <label key={value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio" name="audience" value={value}
                  checked={audience === value}
                  onChange={() => setAudience(value)}
                  className="mt-1"
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>

          {/* The audience is restated right above the box, because getting this
              wrong means an internal note reaches a resident. */}
          <div className="space-y-1.5">
            <label htmlFor="body" className="block text-sm font-medium text-ink-700">
              Comment
            </label>
            <textarea
              id="body" name="body" rows={4} required
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
            <p className={audience === 'internal' ? 'text-xs text-ink-500' : 'text-xs font-medium text-caution-700'}>
              {audience === 'internal'
                ? 'This note stays inside your team.'
                : audience === 'resident_visible'
                  ? 'The resident will be able to read this.'
                  : 'The assigned contractor will be able to read this.'}
            </p>
          </div>

          <Button type="submit" disabled={commenting}>
            {commenting ? 'Adding…' : 'Add comment'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
