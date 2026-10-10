import Link from 'next/link';
import { Card, EmptyState, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { hasPermission, listBankAccounts, listBankImports, listBankLines } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { IdentifyLineForm, ImportStatementForm, ReopenLineForm } from './statement-forms';

export const metadata = { title: 'Bank statements' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: StatusTone; label: string }> = {
  unmatched: { tone: 'caution', label: 'Not identified' },
  suggested: { tone: 'caution', label: 'Suggested' },
  needs_review: { tone: 'critical', label: 'Needs review' },
  matched: { tone: 'positive', label: 'Receipted' },
  ignored: { tone: 'neutral', label: 'Set aside' },
};

/**
 * The bank statement worklist.
 *
 * `bank_imports` and `bank_transactions` have existed since the schema was
 * written, with two unique indexes to stop an overlapping statement being
 * imported twice, and nothing could write a row to either — so the one thing a
 * landlord does every month had no support at all.
 *
 * The page says the same thing in three places because it is the thing that
 * matters: a line here is evidence money arrived, not a receipt. Importing
 * moved nothing. Deciding who paid is a separate act, and the suggestions are
 * suggestions.
 */
export default async function StatementsPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { org } = await params;
  const { show } = await searchParams;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => ({
    imports: await listBankImports(tx, context.organisationId),
    lines: await listBankLines(tx, context.organisationId, {
      onlyUnmatched: show !== 'all',
    }),
    accounts: await listBankAccounts(tx, context.organisationId),
    canImport: await hasPermission(tx, context.organisationId, 'bank.import'),
  }));
  const { imports, lines, accounts, canImport } = data;

  const stillToIdentify = lines.filter(
    (l) => l.matchStatus !== 'matched' && l.matchStatus !== 'ignored',
  ).length;

  return (
    <div className="space-y-6">
      <Link
        href={`/app/${org}/reconciliation`}
        className="text-sm text-spike-600 hover:underline"
      >
        ← Reconciliation
      </Link>

      <PageHeader
        title="Bank statements"
        description="Lines from a statement you exported yourself. A line is evidence that money arrived — it is not a receipt, and importing one changes nobody's balance."
      />

      {canImport ? (
        <ImportStatementForm
          org={org}
          currencyCode={context.currencyCode}
          accounts={accounts
            .filter((a) => a.isActive)
            .map((a) => ({
              id: a.id,
              label: `${a.label} — ${a.bankName} ••••${a.accountNumberLast4}`,
            }))}
        />
      ) : (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            Importing a statement needs the bank import permission.
          </p>
        </Card>
      )}

      {/* ------------------------------------------------------- worklist */}

      <section aria-labelledby="lines" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="lines" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            {show === 'all' ? 'Every line' : 'Still to identify'}
          </h2>
          <Link
            href={`/app/${org}/reconciliation/statements${show === 'all' ? '' : '?show=all'}`}
            className="text-sm text-spike-600 hover:underline"
          >
            {show === 'all' ? 'Show only what is unidentified' : 'Show every line'}
          </Link>
        </div>

        {show !== 'all' && stillToIdentify > 0 ? (
          <p className="text-sm text-ink-500">
            {stillToIdentify === 1
              ? '1 line has not been tied to anything yet.'
              : `${stillToIdentify} lines have not been tied to anything yet.`}
          </p>
        ) : null}

        {lines.length === 0 ? (
          <EmptyState
            title={show === 'all' ? 'No statement lines yet' : 'Nothing left to identify'}
            description={
              show === 'all'
                ? 'Import a statement above. Nothing is imported until you have seen what it will do.'
                : 'Every imported line is either receipted or set aside with a reason.'
            }
          />
        ) : (
          <ul className="space-y-3">
            {lines.map((l) => (
              <li key={l.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-900">{l.description || 'No description'}</p>
                      <p className="text-xs text-ink-500">
                        {formatDate(l.transactionDate, context.timeZone)} · {l.bankName}
                        {l.filename ? ` · ${l.filename}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={l.amountMinor > 0n ? '' : 'text-ink-500'}>
                        <Money
                          minor={l.amountMinor} currency={l.currencyCode}
                          emphasise={l.amountMinor > 0n}
                        />
                      </span>
                      <StatusBadge tone={STATUS[l.matchStatus]!.tone}>
                        {STATUS[l.matchStatus]!.label}
                      </StatusBadge>
                    </div>
                  </div>

                  <div className="mt-3 border-t border-ink-100 pt-3">
                    {l.matchStatus === 'matched' ? (
                      <p className="text-sm text-ink-700">
                        Receipted as {l.matchedReceiptNumber}.{' '}
                        <Link
                          href={`/app/${org}/reconciliation/${l.matchedReceiptId}`}
                          className="text-spike-600 hover:underline"
                        >
                          Open the receipt →
                        </Link>
                      </p>
                    ) : l.matchStatus === 'ignored' ? (
                      canImport ? <ReopenLineForm org={org} bankTransactionId={l.id} /> : null
                    ) : canImport ? (
                      <IdentifyLineForm
                        org={org}
                        currencyCode={l.currencyCode}
                        line={{
                          id: l.id,
                          description: l.description,
                          transactionDate: l.transactionDate,
                          amountMinor: l.amountMinor.toString(),
                          isCredit: l.amountMinor > 0n,
                        }}
                      />
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* -------------------------------------------------------- history */}

      {imports.length > 0 ? (
        <section aria-labelledby="imports" className="space-y-3">
          <h2 id="imports" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Statements imported
          </h2>
          <Card className="divide-y divide-ink-100">
            {imports.map((i) => (
              <div key={i.id} className="flex flex-wrap items-baseline justify-between gap-3 p-4">
                <div>
                  <p className="text-sm font-medium text-ink-900">{i.filename}</p>
                  <p className="text-xs text-ink-500">
                    {i.bankName}
                    {i.statementStart
                      ? ` · ${formatDate(i.statementStart, context.timeZone)} to `
                        + `${formatDate(i.statementEnd!, context.timeZone)}`
                      : ''}
                    {i.createdByName ? ` · imported by ${i.createdByName}` : ''}
                    {' · '}{formatDate(i.createdAt, context.timeZone)}
                  </p>
                </div>
                <p className="text-xs text-ink-500">
                  {i.importedCount} imported
                  {i.duplicateCount > 0 ? `, ${i.duplicateCount} already held` : ''}
                  {i.unmatchedCount > 0 ? `, ${i.unmatchedCount} still to identify` : ''}
                </p>
              </div>
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}
