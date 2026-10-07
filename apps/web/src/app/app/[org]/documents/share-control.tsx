'use client';

import { useActionState } from 'react';
import { StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { shareDocumentAction } from './actions';

const LABEL: Record<string, { tone: StatusTone; label: string; glyph: string }> = {
  internal:          { tone: 'neutral', label: 'Internal',                glyph: '🔒' },
  resident_shared:   { tone: 'info',    label: 'Shared with resident',    glyph: '👤' },
  contractor_shared: { tone: 'caution', label: 'Shared with contractor',  glyph: '🔧' },
  owner_shared:      { tone: 'info',    label: 'Shared with owner',       glyph: '🏠' },
};

export function ShareControl({
  org, documentId, visibility, quarantined, canShareToResident,
}: {
  org: string; documentId: string; visibility: string;
  quarantined: boolean; canShareToResident: boolean;
}) {
  const [state, action, pending] = useActionState(shareDocumentAction, null);
  const current = LABEL[visibility] ?? LABEL.internal!;

  // A quarantined file cannot be shared at all, so the control is not offered.
  // The database would refuse it anyway; hiding it avoids a pointless error.
  if (quarantined) {
    return (
      <div className="space-y-1">
        <StatusBadge tone="caution" glyph="▲">Quarantined</StatusBadge>
        <p className="text-xs text-ink-400">Cannot be shared</p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="documentId" value={documentId} />
      <label className="sr-only" htmlFor={`visibility-${documentId}`}>
        Who can see this document
      </label>
      <select
        id={`visibility-${documentId}`}
        name="visibility"
        defaultValue={visibility}
        disabled={pending}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-xs"
      >
        <option value="internal">Internal only</option>
        <option value="resident_shared" disabled={!canShareToResident}>
          Share with resident{canShareToResident ? '' : ' (needs a lease link)'}
        </option>
        <option value="contractor_shared">Share with contractor</option>
        <option value="owner_shared">Share with owner</option>
      </select>
      {state && !state.ok ? (
        <p role="alert" className="text-xs text-critical-700">{state.message}</p>
      ) : (
        <p className="text-xs text-ink-400">{current.label}</p>
      )}
    </form>
  );
}
