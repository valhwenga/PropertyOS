'use client';

import { useActionState, useState } from 'react';
import { Button, Card, DataTable, ErrorState, Money, StatusBadge, Td, Th } from '@propertyos/ui';
import type { ImportKind } from '@propertyos/domain';
import { commitImportAction, previewImportAction } from './actions';

export function ImportWizard({ org, kind }: { org: string; kind: ImportKind }) {
  const [previewState, preview, previewing] = useActionState(previewImportAction, null);
  const [commitState, commit, committing] = useActionState(commitImportAction, null);
  const [confirmed, setConfirmed] = useState(false);

  const isMoney = kind === 'opening_balances' || kind === 'deposits';
  const needsApproval = kind === 'opening_balances';

  if (commitState?.ok) {
    return (
      <Card className="border-positive-600/25 bg-positive-50 p-5">
        <p className="text-sm font-semibold text-positive-600">Imported</p>
        <p className="mt-1 text-sm text-ink-700">
          {commitState.importedCount} row{commitState.importedCount === 1 ? '' : 's'} imported
          {commitState.totalMinor !== undefined ? (
            <> · total <Money minor={commitState.totalMinor} /></>
          ) : null}
          .
        </p>
        {commitState.limitedAgeingDetail ? (
          <p className="mt-2 text-sm text-ink-700">
            <StatusBadge tone="caution" glyph="▲">Limited ageing detail</StatusBadge>{' '}
            Some balances were supplied as a single total with no original due date. Arrears
            ageing for those residents will show the amount but cannot age it accurately.
          </p>
        ) : null}
        <a href={`/app/${org}/onboarding?kind=${kind}`} className="mt-3 inline-block text-sm font-medium text-spike-600 hover:underline">
          Import another file →
        </a>
      </Card>
    );
  }

  const result = previewState?.ok ? previewState.preview : null;
  const ready = result && result.errors.length === 0 && result.validCount > 0;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          1. Check your file
        </h2>

        {previewState && !previewState.ok ? (
          <div className="mt-3">
            <ErrorState title="Could not read the file" detail={previewState.message} correlationId={previewState.correlationId} />
          </div>
        ) : null}

        <form action={preview} className="mt-3 space-y-3">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="kind" value={kind} />
          <div className="space-y-1.5">
            <label htmlFor="file" className="block text-sm font-medium text-ink-700">CSV file</label>
            <input
              id="file" name="file" type="file" accept=".csv,text/csv" required
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-spike-50 file:px-3 file:py-1.5 file:text-sm file:text-spike-700"
            />
            <p className="text-xs text-ink-400">
              Nothing is saved at this step. You will see any problems before anything is imported.
            </p>
          </div>
          <Button type="submit" disabled={previewing}>
            {previewing ? 'Checking…' : 'Check the file'}
          </Button>
        </form>
      </Card>

      {result ? (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              2. Review
            </h2>
            {result.errors.length === 0 ? (
              <StatusBadge tone="positive" glyph="✓">
                {result.validCount} of {result.rowCount} rows ready
              </StatusBadge>
            ) : (
              <StatusBadge tone="critical" glyph="▲">
                {result.errors.length} problem{result.errors.length === 1 ? '' : 's'} to fix
              </StatusBadge>
            )}
          </div>

          {result.errors.length > 0 ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-ink-700">
                Fix these in your spreadsheet and upload again. Row numbers match your file.
              </p>
              <DataTable
                caption="Problems found in the file"
                dense
                head={<tr><Th>Row</Th><Th>Column</Th><Th>What is wrong</Th></tr>}
              >
                {result.errors.slice(0, 100).map((error, index) => (
                  <tr key={index}>
                    <Td className="tabular whitespace-nowrap">{error.line}</Td>
                    <Td className="tabular text-ink-500">{error.field ?? '—'}</Td>
                    <Td>{error.message}</Td>
                  </tr>
                ))}
              </DataTable>
              {result.errors.length > 100 ? (
                <p className="text-xs text-ink-400">
                  Showing the first 100 of {result.errors.length} problems.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {isMoney && result.totalMinor !== undefined ? (
                <p className="text-sm text-ink-700">
                  Total to import: <Money minor={result.totalMinor} emphasise />
                </p>
              ) : null}

              {result.limitedAgeingDetail ? (
                <p className="rounded-lg border border-caution-700/25 bg-caution-50 px-3 py-2 text-sm text-ink-700">
                  Some rows have no original due date, so those balances cannot be aged
                  accurately. They will be recorded with the ageing detail marked as limited,
                  rather than being given an age they do not have.
                </p>
              ) : null}

              <div className="overflow-x-auto">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">
                  First {result.sample.length} row{result.sample.length === 1 ? '' : 's'}
                </p>
                <table className="w-full min-w-[32rem] border-collapse text-xs">
                  <thead className="bg-ink-50 text-left">
                    <tr>
                      {Object.keys(result.sample[0] ?? {}).map((key) => (
                        <th key={key} className="px-2 py-1.5 font-medium text-ink-500">{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {result.sample.map((row, index) => (
                      <tr key={index}>
                        {Object.values(row).map((value, i) => (
                          <td key={i} className="px-2 py-1.5">{value || <span className="text-ink-300">—</span>}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {ready && previewState?.ok ? (
        <Card className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">3. Import</h2>

          {commitState && !commitState.ok ? (
            <div className="mt-3">
              <ErrorState title="Nothing was imported" detail={commitState.message} correlationId={commitState.correlationId} />
            </div>
          ) : null}

          <form action={commit} className="mt-3 space-y-4">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="filename" value={result.filename} />
            <input type="hidden" name="content" value={previewState.content} />

            {needsApproval ? (
              <>
                {/* The three controls the blueprint requires before opening
                    balances may be recorded. None of them is optional. */}
                <div className="space-y-1.5">
                  <label htmlFor="cutOffDate" className="block text-sm font-medium text-ink-700">
                    Cut-off date
                  </label>
                  <input
                    id="cutOffDate" name="cutOffDate" type="date" required
                    className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                  />
                  <p className="text-xs text-ink-400">
                    The date these balances are correct as at. Charges after this date should be
                    billed normally, not imported.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="sourceReference" className="block text-sm font-medium text-ink-700">
                    Where these figures came from
                  </label>
                  <input
                    id="sourceReference" name="sourceReference" type="text" required minLength={3}
                    placeholder="e.g. Accountant ledger export, signed 31 December 2025"
                    className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                  />
                  <p className="text-xs text-ink-400">
                    Recorded against every balance, so a statement can always show its source.
                  </p>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-caution-700/30 bg-caution-50 px-3 py-3 text-sm">
                  <input
                    type="checkbox" name="confirmApproval" required className="mt-0.5"
                    checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span className="text-ink-700">
                    I have checked these opening balances against our own records and confirm they
                    are correct. My name will be recorded as the approver.
                  </span>
                </label>
              </>
            ) : null}

            <Button type="submit" variant="primary" disabled={committing || (needsApproval && !confirmed)}>
              {committing
                ? 'Importing…'
                : `Import ${result.validCount} row${result.validCount === 1 ? '' : 's'}`}
            </Button>
            <p className="text-xs text-ink-400">
              All or nothing: if anything fails, nothing is saved.
            </p>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
