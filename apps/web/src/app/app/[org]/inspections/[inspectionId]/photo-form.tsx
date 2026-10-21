'use client';

import { useActionState } from 'react';
import { Button } from '@propertyos/ui';
import { attachInspectionPhotoAction } from '../actions';

/**
 * A photograph against one checklist item.
 *
 * Per item, because "there is a photograph somewhere on this report" is not
 * evidence about a worktop. `inspection_photos` had existed since the
 * operations migration with nothing in the product ever writing to it.
 *
 * Compact on purpose: it sits on every row of a checklist that can run to
 * twenty items, so it is a file field and a button, and the consequence —
 * that nothing can be opened until a scanner is configured — is said once
 * above the list rather than twenty times inside it.
 */
export function InspectionPhotoForm({
  org, inspectionId, itemId, label, count,
}: {
  org: string; inspectionId: string; itemId: string; label: string; count: number;
}) {
  const [state, action, pending] = useActionState(attachInspectionPhotoAction, null);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="inspectionId" value={inspectionId} />
      <input type="hidden" name="itemId" value={itemId} />
      <input
        type="file" name="photo" accept="image/jpeg,image/png" required
        aria-label={`Photograph of ${label}`}
        className="max-w-56 text-xs text-ink-600"
      />
      <Button type="submit" disabled={pending}>
        {pending ? 'Attaching…' : 'Attach'}
      </Button>
      {count > 0 ? (
        <span className="text-xs text-ink-500">
          {count} photograph{count === 1 ? '' : 's'} on file
        </span>
      ) : null}
      {state?.ok ? (
        <span className="text-xs font-medium text-positive-600">Attached</span>
      ) : null}
      {state && !state.ok ? (
        <span className="text-xs text-critical-700">{state.message}</span>
      ) : null}
    </form>
  );
}
