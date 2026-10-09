'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { postBillingRunAction, prepareBillingRunAction } from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

/**
 * Records the reviewed preview as a run.
 *
 * Writes nothing financial. It is the step that turns "what this period would
 * raise" into a numbered thing an approver can post, with the figures pinned to
 * a preview version so what gets posted is what was reviewed.
 */
export function PrepareRunForm({
  org, periodStart, blockingCount,
}: {
  org: string; periodStart: string; blockingCount: number;
}) {
  const [state, action, pending] = useActionState(prepareBillingRunAction, null);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="periodStart" value={periodStart} />
      <Problem state={state} title="Could not prepare this run" />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Preparing…' : 'Prepare this run'}
      </Button>
      {blockingCount > 0 ? (
        <p className="text-xs text-caution-700">
          {blockingCount} blocking exception{blockingCount === 1 ? '' : 's'} will be recorded with
          the run. It cannot be posted until they are resolved and the period is prepared again.
        </p>
      ) : null}
    </form>
  );
}

/**
 * Posting a run.
 *
 * The confirmation step is not decoration. §15 requires confirmation for
 * irreversible financial posting, and this is irreversible: a posted charge
 * cannot be edited or deleted, only corrected with a linked credit note. The
 * figures are restated inside the confirmation so nobody approves a number they
 * have scrolled past.
 */
export function PostRunForm({
  org, runId, previewVersion, defaultIssueDate, lineCount, totalLabel,
}: {
  org: string; runId: string; previewVersion: number;
  /** The period being billed, not today. See the note on the field below. */
  defaultIssueDate: string;
  lineCount: number; totalLabel: string;
}) {
  const [state, action, pending] = useActionState(postBillingRunAction, null);
  const [confirming, setConfirming] = useState(false);

  // No success branch here on purpose. Posting revalidates the page, the run
  // comes back with status `posted`, and the page renders its posted view
  // instead of this form — so a success card rendered here would be code that
  // never shows. What the operator sees afterwards is the run itself: the
  // charges it raised, and the batch summary to download.

  if (!confirming) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not post this run" />
        <Button type="button" variant="primary" onClick={() => setConfirming(true)}>
          Approve and post this run
        </Button>
      </div>
    );
  }

  return (
    <Card className="border-spike-300 p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="runId" value={runId} />
        {/* The version being approved travels with the approval. If the
            underlying data moved since the preview, the domain refuses rather
            than posting figures nobody looked at. */}
        <input type="hidden" name="previewVersion" value={previewVersion} />

        <h3 className="text-sm font-semibold text-ink-900">Post this billing run</h3>
        <Problem state={state} title="Could not post this run" />

        <p className="text-sm text-ink-700">
          This raises <strong>{lineCount}</strong> charge{lineCount === 1 ? '' : 's'} totalling{' '}
          <strong>{totalLabel}</strong> against residents&rsquo; accounts.
        </p>
        <p className="text-sm text-ink-700">
          A posted charge cannot be edited or deleted. Correcting one afterwards means issuing a
          linked credit note, which the resident sees. Re-running this does not double-bill:
          each schedule and period can produce one charge only.
        </p>

        <div className="space-y-1.5">
          <label htmlFor="issueDate" className="block text-sm font-medium text-ink-700">
            Issue date
          </label>
          <input
            id="issueDate" name="issueDate" type="date" defaultValue={defaultIssueDate} required
            className="rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
          <p className="text-xs text-ink-500">
            The date the invoices carry. Defaults to the first day of the period being billed,
            not to today: an invoice for a month is dated in that month, and a charge may not be
            issued after it falls due. Due dates come from each schedule.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Posting…' : `Post ${lineCount} charge${lineCount === 1 ? '' : 's'}`}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
