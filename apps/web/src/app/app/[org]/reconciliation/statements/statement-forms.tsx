'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import {
  ignoreLineAction, importStatementAction, previewStatementAction, reopenLineAction,
  suggestPayersAction,
} from './actions';

/**
 * Importing a statement, and identifying what it contains.
 *
 * The screen is built around one idea the operator has to leave with: a line
 * on a statement is evidence money arrived, not a receipt. Importing changes
 * no balance. Deciding who paid is a separate, deliberate act, and this never
 * does it for them — not even when exactly one candidate matches.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface AccountChoice { id: string; label: string }

interface PreviewRow {
  line: number;
  verdict: 'new' | 'already_imported' | 'unreadable';
  transactionDate?: string;
  description?: string;
  amountMinor?: string;
  problem?: string;
}

interface Preview {
  rows: PreviewRow[];
  newCount: number;
  duplicateCount: number;
  unreadableCount: number;
  creditsMinor: string;
  debitsMinor: string;
  statementStart: string | null;
  statementEnd: string | null;
  sameFileAlreadyImported: boolean;
}

function money(minor: string | undefined, currency: string): string {
  if (minor === undefined) return '—';
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const major = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'ZAR' ? 'R' : `${currency} `;
  return `${negative ? '−' : ''}${symbol}${grouped}`;
}

const VERDICT: Record<string, { tone: 'positive' | 'neutral' | 'critical'; label: string }> = {
  new: { tone: 'positive', label: 'Will import' },
  already_imported: { tone: 'neutral', label: 'Already imported' },
  unreadable: { tone: 'critical', label: 'Cannot read' },
};

export function ImportStatementForm({
  org, accounts, currencyCode,
}: {
  org: string; accounts: AccountChoice[]; currencyCode: string;
}) {
  const [previewState, preview, previewing] = useActionState(previewStatementAction, null);
  const [importState, runImport, importing] = useActionState(importStatementAction, null);
  const [mode, setMode] = useState<'file' | 'paste'>('file');

  const data = previewState?.ok
    ? (previewState as unknown as { preview: Preview; filename: string; csv: string })
    : null;

  if (accounts.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-ink-700">
          No active bank account. A statement is imported against the account it came from, so
          add the account under Settings first.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form action={preview} className="space-y-4">
          <input type="hidden" name="org" value={org} />
          <h2 className="text-sm font-semibold text-ink-900">Import a statement</h2>
          <p className="text-sm text-ink-500">
            A CSV exported from your own banking site. <strong>No bank is contacted</strong> —
            there is no feed and no credentials, and nothing is stored except the lines
            themselves. Importing creates no receipt and changes nobody&rsquo;s balance.
          </p>
          <Problem state={previewState} title="Could not read that file" />

          <div className="space-y-1.5">
            <label htmlFor="bankAccountId" className="block text-sm font-medium text-ink-700">
              Which account is this statement for?
            </label>
            <select
              id="bankAccountId" name="bankAccountId" required
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>

          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode('file')}
              className={mode === 'file' ? 'font-semibold text-spike-700' : 'text-ink-500'}
            >
              Choose a file
            </button>
            <span className="text-ink-300">·</span>
            <button
              type="button"
              onClick={() => setMode('paste')}
              className={mode === 'paste' ? 'font-semibold text-spike-700' : 'text-ink-500'}
            >
              Paste the rows
            </button>
          </div>

          {mode === 'file' ? (
            <div className="space-y-1.5">
              <label htmlFor="statement" className="block text-sm font-medium text-ink-700">
                Statement file
              </label>
              <input
                id="statement" name="statement" type="file" accept=".csv,text/csv,text/plain"
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="pasted" className="block text-sm font-medium text-ink-700">
                Rows, with a header line
              </label>
              <textarea
                id="pasted" name="pasted" rows={6}
                placeholder={'Date,Description,Amount\n07/01/2026,EFT MOKOENA,7500.00'}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 font-mono text-sm"
              />
            </div>
          )}

          <details className="text-sm text-ink-500">
            <summary className="cursor-pointer font-medium text-ink-700">
              What the columns can be called
            </summary>
            <ul className="mt-2 space-y-1">
              <li><strong>Date</strong> — date, transaction date, posting date, value date.</li>
              <li><strong>Description</strong> — description, details, narrative, reference.</li>
              <li>
                <strong>Amount</strong> — amount or value, signed; or separate debit and credit
                columns.
              </li>
              <li>
                <strong>Identifier</strong> (optional) — transaction id or bank reference. When
                the bank gives one it is used instead of matching on the other columns.
              </li>
            </ul>
            <p className="mt-2">
              Dates may be 2026-03-31 or 31/03/2026. A two-digit year is refused rather than
              guessed at: a line in the wrong century lands in the wrong period.
            </p>
          </details>

          <Button type="submit" variant="secondary" disabled={previewing}>
            {previewing ? 'Reading…' : 'Check the file'}
          </Button>
        </form>
      </Card>

      {data ? (
        <Card className="p-5">
          <form action={runImport} className="space-y-4">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="pasted" value={data.csv} />
            <input type="hidden" name="filename" value={data.filename} />
            <h2 className="text-sm font-semibold text-ink-900">
              What this will do
            </h2>
            <Problem state={importState} title="Nothing was imported" />
            {importState?.ok ? (
              <p className="text-sm font-semibold text-positive-600">
                Imported. No receipt was created and no balance moved — identify each line
                below.
              </p>
            ) : null}

            <dl className="grid gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-500">New lines</dt>
                <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
                  {data.preview.newCount}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-500">Already imported</dt>
                <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
                  {data.preview.duplicateCount}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-500">Money in</dt>
                <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
                  {money(data.preview.creditsMinor, currencyCode)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-500">Money out</dt>
                <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
                  {money(data.preview.debitsMinor, currencyCode)}
                </dd>
              </div>
            </dl>

            {data.preview.statementStart ? (
              <p className="text-sm text-ink-500">
                {data.preview.statementStart} to {data.preview.statementEnd}
                {data.preview.sameFileAlreadyImported
                  ? ' · this exact file has been imported before'
                  : ''}
              </p>
            ) : null}

            {data.preview.unreadableCount > 0 ? (
              <div className="rounded-lg border border-critical-700/30 bg-critical-50 p-3">
                <p className="text-sm font-semibold text-critical-700">
                  {data.preview.unreadableCount === 1
                    ? '1 row cannot be read and will not be imported'
                    : `${data.preview.unreadableCount} rows cannot be read and will not be imported`}
                </p>
                <ul className="mt-2 space-y-1 text-sm text-ink-700">
                  {data.preview.rows.filter((r) => r.verdict === 'unreadable').map((r) => (
                    <li key={r.line}>Row {r.line}: {r.problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="max-h-80 overflow-y-auto rounded-lg border border-ink-100">
              <table className="w-full text-sm">
                <caption className="sr-only">Every row in the file, and what will happen to it</caption>
                <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th scope="col" className="px-3 py-2">Row</th>
                    <th scope="col" className="px-3 py-2">Date</th>
                    <th scope="col" className="px-3 py-2">Description</th>
                    <th scope="col" className="px-3 py-2 text-right">Amount</th>
                    <th scope="col" className="px-3 py-2">What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.preview.rows.map((r) => (
                    <tr key={r.line} className="border-t border-ink-100">
                      <td className="tabular px-3 py-2 text-ink-500">{r.line}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.transactionDate ?? '—'}</td>
                      <td className="px-3 py-2">{r.description || '—'}</td>
                      <td className="tabular px-3 py-2 text-right">
                        {money(r.amountMinor, currencyCode)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge tone={VERDICT[r.verdict]!.tone}>
                          {VERDICT[r.verdict]!.label}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.preview.newCount > 0 && !importState?.ok ? (
              <>
                {/* The account is re-read from the preview form's own choice
                    rather than carried in a hidden field the browser could
                    change: the server recomputes the whole preview anyway, and
                    an account it refuses is an account it refuses. */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="confirmAccount"
                    className="block text-sm font-medium text-ink-700"
                  >
                    Import into
                  </label>
                  <select
                    id="confirmAccount" name="bankAccountId" required
                    className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                  >
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
                <Button type="submit" variant="primary" disabled={importing}>
                  {importing
                    ? 'Importing…'
                    : `Import ${data.preview.newCount} line${data.preview.newCount === 1 ? '' : 's'}`}
                </Button>
              </>
            ) : data.preview.newCount === 0 ? (
              <p className="text-sm text-ink-700">
                Nothing in this file is new, so there is nothing to import.
              </p>
            ) : null}
          </form>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ one line */

export function IdentifyLineForm({
  org, line, currencyCode,
}: {
  org: string; currencyCode: string;
  line: {
    id: string; description: string; amountMinor: string; isCredit: boolean;
    transactionDate: string;
  };
}) {
  const [suggestState, suggest, suggesting] = useActionState(suggestPayersAction, null);
  const [ignoreState, ignore, ignoring] = useActionState(ignoreLineAction, null);
  const [mode, setMode] = useState<'none' | 'aside'>('none');

  const candidates = suggestState?.ok
    ? (suggestState as unknown as {
        candidates: Array<{
          leaseId: string; reference: string; label: string; outstandingMinor: string;
          because: string;
        }>;
      }).candidates
    : null;

  return (
    <div className="space-y-2">
      <Problem state={suggestState} title="Could not look for a payer" />
      <Problem state={ignoreState} title="Could not set the line aside" />

      <div className="flex flex-wrap gap-2">
        {line.isCredit ? (
          <form action={suggest}>
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="bankTransactionId" value={line.id} />
            <Button type="submit" variant="secondary" disabled={suggesting}>
              {suggesting ? 'Looking…' : 'Who might this be?'}
            </Button>
          </form>
        ) : null}
        <Button type="button" variant="secondary" onClick={() => setMode('aside')}>
          Not a receipt
        </Button>
      </div>

      {candidates ? (
        candidates.length === 0 ? (
          <p className="text-sm text-ink-700">
            Nothing in the description or the amount points at a lease. Record it against the
            lease you know it belongs to, or hold it in suspense until the payer is identified —
            a guess here becomes somebody&rsquo;s wrong balance.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-ink-500">
              Suggestions, not answers. {candidates.length === 1
                ? 'One lease matches; it is still your decision.'
                : `${candidates.length} leases match.`}
            </p>
            <ul className="space-y-2">
              {candidates.map((c) => (
                <li key={c.leaseId} className="rounded-lg border border-ink-200 p-3">
                  <p className="text-sm font-medium text-ink-900">{c.label}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {c.reference} · owes {money(c.outstandingMinor, currencyCode)}
                  </p>
                  <p className="mt-1 text-sm text-ink-700">Because {c.because}.</p>
                  <a
                    href={`/app/${org}/reconciliation?bankLine=${line.id}`
                      + `&lease=${c.leaseId}&amount=${line.amountMinor}`
                      + `&on=${line.transactionDate}`
                      + `&reference=${encodeURIComponent(line.description)}`}
                    className="mt-2 inline-block text-sm font-medium text-spike-600 hover:underline"
                  >
                    Record a receipt against this lease →
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {mode === 'aside' ? (
        <form action={ignore} className="space-y-2 rounded-lg border border-ink-200 p-3">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="bankTransactionId" value={line.id} />
          <p className="text-sm text-ink-700">
            For a line that is not a resident&rsquo;s payment — a bank charge, a transfer between
            your own accounts, a card expense. It is not deleted, and it is not a receipt: it is
            marked as looked at, so the list below means &ldquo;still to identify&rdquo;.
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor={`reason-${line.id}`}
              className="block text-sm font-medium text-ink-700"
            >
              Why it is not a receipt
            </label>
            <input
              id={`reason-${line.id}`} name="reason" required
              placeholder="Monthly bank charges, recorded as an expense instead."
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={ignoring}>
              {ignoring ? 'Saving…' : 'Set it aside'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode('none')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function ReopenLineForm({ org, bankTransactionId }: { org: string; bankTransactionId: string }) {
  const [state, action, pending] = useActionState(reopenLineAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="bankTransactionId" value={bankTransactionId} />
      <Problem state={state} title="Could not put it back" />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Saving…' : 'Put back on the worklist'}
      </Button>
    </form>
  );
}
