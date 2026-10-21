'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import { respondToInspectionAction } from '../actions';

/**
 * Agreeing or disagreeing with an inspection report.
 *
 * A dispute requires a description — the domain insists, and so does this
 * form, because "I disagree" with nothing after it gives the landlord nothing
 * to act on and the resident no record of what they said.
 *
 * Changing your mind is allowed: the answer is stored one per resident per
 * inspection and updated, not appended. Somebody who acknowledges a report and
 * then finds the damage was there before them must be able to say so.
 */
export function InspectionResponseForm({
  leaseId, inspectionId, existing,
}: {
  leaseId: string; inspectionId: string;
  existing: { response: string; comment: string | null } | null;
}) {
  const [state, action, pending] = useActionState(respondToInspectionAction, null);
  const [choice, setChoice] = useState(existing?.response ?? '');

  return (
    <form action={action} className="mt-3 space-y-3 border-t border-ink-100 pt-3">
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="inspectionId" value={inspectionId} />

      {state && !state.ok ? (
        <ErrorState
          title="Your response was not recorded"
          detail={state.message ?? 'Nothing was saved.'}
          correlationId={state.correlationId}
        />
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-900">
          {existing ? 'Change your response' : 'Do you agree with this report?'}
        </legend>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input
            type="radio" name="response" value="acknowledged" className="mt-1"
            defaultChecked={existing?.response === 'acknowledged'}
            onChange={() => setChoice('acknowledged')}
          />
          <span>I agree this is what the property was like.</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input
            type="radio" name="response" value="disputed" className="mt-1"
            defaultChecked={existing?.response === 'disputed'}
            onChange={() => setChoice('disputed')}
          />
          <span>
            I disagree with something in it. Say what below — a deduction from your deposit
            has to be justified against this report, so what you write here is the record of
            your side of it.
          </span>
        </label>
      </fieldset>

      <div>
        <label htmlFor={`comment-${inspectionId}`} className="block text-sm font-medium text-ink-700">
          {choice === 'disputed' ? 'What do you disagree with?' : 'Anything to add (optional)'}
        </label>
        <textarea
          id={`comment-${inspectionId}`}
          name="comment"
          rows={3}
          required={choice === 'disputed'}
          defaultValue={existing?.comment ?? ''}
          className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900"
          placeholder={choice === 'disputed'
            ? 'The mark on the lounge wall was there when I moved in — it is in the move-in photos.'
            : ''}
        />
      </div>

      <Button type="submit" variant="primary" disabled={pending || choice === ''}>
        {pending ? 'Saving…' : existing ? 'Update my response' : 'Send my response'}
      </Button>
    </form>
  );
}
