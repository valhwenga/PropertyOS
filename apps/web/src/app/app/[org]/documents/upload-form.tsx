'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import { uploadDocument } from './actions';

const CLASSIFICATIONS = [
  ['lease', 'Lease agreement'],
  ['invoice', 'Supplier invoice'],
  ['inspection', 'Inspection report'],
  ['maintenance', 'Maintenance evidence'],
  ['deposit_evidence', 'Deposit evidence'],
  ['identity', 'Identity document'],
  ['other', 'Other'],
] as const;

export function UploadForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(uploadDocument, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        Upload a document
      </Button>
    );
  }

  return (
    <Card className="w-full p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Upload a document
        </h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-500 hover:underline">
          Close
        </button>
      </div>

      {state && !state.ok ? (
        <div className="mt-3">
          <ErrorState title="Upload refused" detail={state.message} correlationId={state.correlationId} />
        </div>
      ) : null}

      {state?.ok ? (
        <div className="mt-3 rounded-lg border border-info-700/25 bg-info-50 px-4 py-3">
          <p className="text-sm font-semibold text-info-700">Uploaded</p>
          {state.quarantined ? (
            <p className="mt-1 text-sm text-ink-700">
              <StatusBadge tone="caution" glyph="▲">Quarantined</StatusBadge>{' '}
              {state.scanStatus === 'skipped_not_configured'
                ? 'No malware scanner is configured, so this file has NOT been scanned. It cannot be shared until it clears quarantine.'
                : 'The scan did not complete, so this file stays quarantined and cannot be shared.'}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-700">
              <StatusBadge tone="positive" glyph="✓">Scanned clean</StatusBadge>{' '}
              You can now share it with a resident, contractor or owner.
            </p>
          )}
        </div>
      ) : null}

      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="org" value={org} />

        <div className="space-y-1.5">
          <label htmlFor="file" className="block text-sm font-medium text-ink-700">File</label>
          <input
            id="file" name="file" type="file" required
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.csv,.docx,.xlsx"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-spike-50 file:px-3 file:py-1.5 file:text-sm file:text-spike-700"
          />
          <p className="text-xs text-ink-400">
            PDF, images, CSV, Word or Excel. Up to 25 MB. Executables are rejected, and the
            file content is checked against its declared type.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="title" className="block text-sm font-medium text-ink-700">
            Title <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <input
            id="title" name="title" type="text" maxLength={200}
            placeholder="Defaults to the file name"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="classification" className="block text-sm font-medium text-ink-700">
            Classification
          </label>
          <select
            id="classification" name="classification" required defaultValue="lease"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          >
            {CLASSIFICATIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <p className="text-xs text-ink-400">
            Identity documents need a separate permission to download, even inside your team.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="leaseId" className="block text-sm font-medium text-ink-700">
            Link to a lease <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <input
            id="leaseId" name="leaseId" type="text"
            placeholder="Lease ID — required before a document can be shared with a resident"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        {/* Every upload starts internal and quarantined; sharing is a separate,
            deliberate step. Saying so here avoids the surprise later. */}
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-500">
          Uploads are private and start as internal. Nothing is shared with a resident,
          contractor or owner until you explicitly share it, and a file that has not cleared
          quarantine cannot be shared at all.
        </p>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Uploading…' : 'Upload'}
        </Button>
      </form>
    </Card>
  );
}
