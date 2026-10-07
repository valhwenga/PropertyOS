'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { createLinkAction, decideApplicationAction, setLinkActiveAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export function NewLinkForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(createLinkAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return <Button variant="primary" onClick={() => setOpen(true)}>New application link</Button>;
  }
  return (
    <Card className="w-full p-4">
      <form action={action} className="space-y-3">
        <input type="hidden" name="org" value={org} />
        {state && !state.ok ? (
          <ErrorState title="Could not create that link" detail={state.message}
                      correlationId={state.correlationId} />
        ) : null}
        {state?.ok ? (
          <p className="text-sm text-positive-600">
            Created. Copy its address from the list below.
          </p>
        ) : null}
        <div>
          <label className="block text-sm font-medium text-ink-700" htmlFor="label">
            What is this link for?
          </label>
          <input id="label" name="label" required maxLength={120} className={`mt-1 ${FIELD}`}
                 placeholder="14 Protea Street — 2 bed" />
          <p className="mt-1 text-xs text-ink-500">
            Applicants see this, so name the place rather than the campaign.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create link'}
          </Button>
          <button type="button" onClick={() => setOpen(false)}
                  className="text-sm text-ink-500 hover:underline">Close</button>
        </div>
      </form>
    </Card>
  );
}

export function LinkControls({
  org, linkId, active, url,
}: { org: string; linkId: string; active: boolean; url: string }) {
  const [, action, pending] = useActionState(setLinkActiveAction, null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex shrink-0 items-center gap-3">
      <code className="max-w-[18rem] truncate rounded bg-ink-50 px-2 py-1 text-xs text-ink-700">
        {url}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(url).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
            // Clipboard access can be refused. Saying so beats a button that
            // silently does nothing.
            () => { setCopied(false); window.prompt('Copy this address', url); },
          );
        }}
        className="text-sm text-spike-700 hover:underline"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <form action={action}>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="linkId" value={linkId} />
        <input type="hidden" name="active" value={active ? 'no' : 'yes'} />
        <button type="submit" disabled={pending}
                className="text-sm text-ink-500 hover:underline disabled:opacity-50">
          {pending ? '…' : active ? 'Revoke' : 'Re-enable'}
        </button>
      </form>
    </div>
  );
}

export function ApplicationDecision({
  org, applicationId, status,
}: { org: string; applicationId: string; status: string }) {
  const [state, action, pending] = useActionState(decideApplicationAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
              className="mt-3 text-sm text-spike-700 hover:underline">
        {status === 'received' ? 'Record a decision' : 'Change the decision'}
      </button>
    );
  }
  return (
    <form action={action} className="mt-3 space-y-2 rounded-lg border border-ink-100 p-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="applicationId" value={applicationId} />
      {state && !state.ok ? (
        <p className="text-sm text-critical-700">{state.message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-700" htmlFor={`status-${applicationId}`}>Decision</label>
        <select id={`status-${applicationId}`} name="status" defaultValue="screening"
                className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-sm">
          <option value="screening">Screening</option>
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
      </div>
      <div>
        <label className="block text-sm text-ink-700" htmlFor={`note-${applicationId}`}>
          Why?
        </label>
        <textarea id={`note-${applicationId}`} name="note" required rows={2} minLength={3}
                  className={`mt-1 ${FIELD}`}
                  placeholder="The reason for this decision, kept with it." />
        <p className="mt-1 text-xs text-ink-500">
          Required. A decision with no reason is one nobody can account for later.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : 'Record decision'}
        </Button>
        <button type="button" onClick={() => setOpen(false)}
                className="text-sm text-ink-500 hover:underline">Cancel</button>
      </div>
    </form>
  );
}
