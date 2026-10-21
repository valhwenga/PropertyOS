'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { importDocumentsAction } from './actions';

/**
 * Choosing the files, and reading back where each one went.
 *
 * Both lists matter. "9 of 10 imported" with no names is a screen that makes
 * somebody re-upload all ten to find the missing one.
 */

interface Outcome {
  ok?: boolean;
  message?: string;
  correlationId?: string;
  stored?: Array<{ filename: string; where: string }>;
  skipped?: Array<{ filename: string; reason: string }>;
}

export function DocumentImportForm({ org, scannerConfigured }: {
  org: string; scannerConfigured: boolean;
}) {
  const [state, action, pending] = useActionState(importDocumentsAction, null);
  const outcome = state?.ok ? (state as Outcome) : null;

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />

        {state && !state.ok ? (
          <ErrorState
            title="Nothing was brought across"
            detail={state.message ?? 'No files were stored.'}
            correlationId={state.correlationId}
          />
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="classification" className="block text-sm font-medium text-ink-700">
            What kind of document is this batch?
          </label>
          <select
            id="classification" name="classification" defaultValue="lease"
            className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm"
          >
            <option value="lease">Signed lease agreements</option>
            <option value="identity">Identity documents</option>
            <option value="inspection">Inspection reports</option>
            <option value="invoice">Invoices and statements</option>
            <option value="deposit_evidence">Deposit evidence</option>
            <option value="other">Something else</option>
          </select>
          <p className="text-xs text-ink-500">
            One kind per batch. Identity documents need their own permission to open
            afterwards, which is why they are not mixed in with the rest.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="files" className="block text-sm font-medium text-ink-700">
            The files — up to ten at a time
          </label>
          <input
            id="files" name="files" type="file" multiple required
            className="block w-full text-sm text-ink-700"
          />
          <p className="text-xs text-ink-500">
            Each file is placed by its NAME: include the lease reference, for example
            <span className="font-mono"> LSE-000007-lease.pdf</span>, or a property code. A name
            that mentions two leases is reported rather than guessed at.
          </p>
        </div>

        {scannerConfigured ? null : (
          <p className="rounded-lg border border-caution-700/25 bg-caution-50 p-3 text-sm text-ink-700">
            <strong>They will be stored and held unopened.</strong> No virus scanner is
            configured on this installation, so an uploaded file cannot be opened by anybody —
            including you — until one is. They are kept, filed against the right lease, and
            become readable the day a scanner is configured.
          </p>
        )}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Bringing them across…' : 'Bring these across'}
        </Button>
      </form>

      {outcome ? (
        <div className="space-y-3">
          {outcome.stored && outcome.stored.length > 0 ? (
            <Card className="border-positive-600/25 bg-positive-50 p-4">
              <p className="text-sm font-semibold text-positive-600">
                {outcome.stored.length} filed
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-ink-700">
                {outcome.stored.map((s) => (
                  <li key={s.filename}>
                    <span className="font-mono text-xs">{s.filename}</span> → {s.where}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {outcome.skipped && outcome.skipped.length > 0 ? (
            <Card className="border-caution-700/25 bg-caution-50 p-4">
              <p className="text-sm font-semibold text-caution-700">
                {outcome.skipped.length} not filed
              </p>
              <ul className="mt-1 space-y-1 text-sm text-ink-700">
                {outcome.skipped.map((s) => (
                  <li key={s.filename}>
                    <span className="font-mono text-xs">{s.filename}</span> — {s.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-500">
                Nothing was stored for these. Rename them and try again, or upload them from
                the lease they belong to.
              </p>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
