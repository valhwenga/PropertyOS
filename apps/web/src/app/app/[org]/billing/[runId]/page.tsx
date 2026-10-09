import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Card, DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { DomainError, formatMoney, hasPermission, previewBillingRun } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadBillingRun } from '@/lib/operations-queries';
import { PostRunForm } from '../billing-forms';

export const metadata = { title: 'Billing run' };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, StatusTone> = {
  preview: 'caution', validated: 'info', posting: 'info', posted: 'positive', failed: 'critical',
};

/** What each exception means and, where there is one, what fixes it. */
const EXCEPTION_HELP: Record<string, string> = {
  missing_rent_schedule:
    'Add a rent schedule to this lease. An active lease with no schedule would be billed nothing, '
    + 'which is a silent loss rather than an obvious error.',
  currency_mismatch:
    'The schedule and the financial book disagree about currency. Combining them would produce a '
    + 'total that means nothing.',
  partial_period_not_prorated:
    'The lease covers only part of this month and the schedule is set to bill in full. Confirm '
    + 'that is intended before posting.',
  already_billed:
    'A charge already exists for this schedule and period. The run will skip it rather than '
    + 'raise a second one.',
};

/**
 * One billing run: the validation report, and the approval.
 *
 * §15 asks for draft preview, validation report, approval, post and a
 * downloadable batch summary. This is the last four; the preview is the Billing
 * screen this page is reached from.
 *
 * A prepared run quotes the preview version it was reviewed at. Posting hands
 * that version back, and the domain refuses if the underlying data moved since
 * — so an approval always applies to figures somebody actually looked at.
 */
export default async function BillingRunPage({
  params,
}: {
  params: Promise<{ org: string; runId: string }>;
}) {
  const { org, runId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    const detail = await loadBillingRun(tx, context.organisationId, runId);
    if (!detail) return undefined;

    // Re-run the preview for a run that has not posted yet, so the validation
    // report describes the data as it stands now rather than as it stood when
    // the run was prepared. A stale report is worse than none: it invites
    // approval of a problem that has since appeared.
    let current: Awaited<ReturnType<typeof previewBillingRun>> | null = null;
    let previewError: string | null = null;
    if (detail.run.status !== 'posted') {
      try {
        current = await previewBillingRun(tx, context.organisationId, {
          periodStart: detail.run.period_start,
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        previewError = error.message;
      }
    }
    return {
      ...detail,
      current,
      previewError,
      canPost: await hasPermission(tx, context.organisationId, 'billing.post'),
    };
  });
  if (!data) notFound();

  const { run, documents, current, previewError, canPost } = data;
  const blocking = current?.exceptions.filter((e) => e.severity === 'blocking') ?? [];
  const warnings = current?.exceptions.filter((e) => e.severity === 'warning') ?? [];
  const postedTotal = documents.reduce((sum, d) => sum + BigInt(d.total_minor), 0n);
  const currency = documents[0]?.currency_code ?? context.currencyCode;

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/billing`} className="text-sm text-spike-600 hover:underline">
        ← Billing
      </Link>

      <PageHeader
        title={`Billing run · ${run.period_start.slice(0, 7)}`}
        description={
          `${formatDate(run.period_start, context.timeZone)} to `
          + `${formatDate(run.period_end, context.timeZone)} · prepared by `
          + `${run.created_by_name ?? 'unknown'} on ${formatDate(run.created_at, context.timeZone)}`
        }
        actions={
          run.status === 'posted' ? (
            <a
              href={`/app/${org}/billing/${runId}/summary.csv`}
              className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
            >
              Download batch summary
            </a>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status}</StatusBadge>
        <span className="text-sm text-ink-500">preview version {run.preview_version}</span>
        {run.posted_at ? (
          <span className="text-sm text-ink-500">
            posted by {run.posted_by_name ?? 'unknown'} on{' '}
            {formatDate(run.posted_at, context.timeZone)}
          </span>
        ) : null}
      </div>

      {/* ----------------------------------------------- validation report */}

      {run.status !== 'posted' ? (
        <section aria-labelledby="validation" className="space-y-3">
          <h2 id="validation" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Validation report
          </h2>

          {previewError ? (
            <Card className="border-critical-700/30 bg-critical-50 p-4">
              <p className="text-sm text-critical-700">{previewError}</p>
            </Card>
          ) : blocking.length === 0 && warnings.length === 0 ? (
            <Card className="border-positive-600/30 bg-positive-50 p-4">
              <p className="text-sm text-positive-600">
                Nothing is blocking this run, and nothing needs a second look.
              </p>
            </Card>
          ) : null}

          {blocking.length > 0 ? (
            <Card className="border-critical-700/30 bg-critical-50 p-4">
              <p className="text-sm font-semibold text-critical-700">
                {blocking.length} blocking exception{blocking.length === 1 ? '' : 's'}
              </p>
              <p className="mt-1 text-sm text-ink-700">
                This run cannot be posted while any of these stands. Fix them, then prepare the
                period again — a new run quotes a new preview version.
              </p>
              <ul className="mt-3 space-y-3">
                {blocking.map((e, i) => (
                  <li key={`${e.code}-${e.leaseId}-${i}`} className="border-l-2 border-critical-700/40 pl-3">
                    <p className="text-sm font-medium text-ink-900">
                      {e.leaseReference ? (
                        <Link
                          href={`/app/${org}/leases/${e.leaseId}`}
                          className="text-spike-600 hover:underline"
                        >
                          {e.leaseReference}
                        </Link>
                      ) : (
                        'Organisation-wide'
                      )}
                    </p>
                    <p className="text-sm text-ink-700">{e.message}</p>
                    {EXCEPTION_HELP[e.code] ? (
                      <p className="mt-0.5 text-xs text-ink-500">{EXCEPTION_HELP[e.code]}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {warnings.length > 0 ? (
            <Card className="border-caution-700/30 bg-caution-50 p-4">
              <p className="text-sm font-semibold text-caution-700">
                {warnings.length} to look at
              </p>
              <p className="mt-1 text-sm text-ink-700">
                None of these stops the run. They are the things that are usually fine and
                occasionally are not.
              </p>
              <ul className="mt-3 space-y-2">
                {warnings.map((e, i) => (
                  <li key={`${e.code}-${e.leaseId}-${i}`} className="border-l-2 border-caution-700/40 pl-3">
                    <p className="text-sm text-ink-900">
                      {e.leaseReference ?? 'Organisation-wide'} — {e.message}
                    </p>
                    {EXCEPTION_HELP[e.code] ? (
                      <p className="text-xs text-ink-500">{EXCEPTION_HELP[e.code]}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </section>
      ) : null}

      {/* -------------------------------------------------------- approval */}

      {run.status === 'posted' ? null : !canPost ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            You prepared this run but cannot post it. Posting raises charges against residents&rsquo;
            accounts and needs the billing approval permission, which is held separately.
          </p>
        </Card>
      ) : blocking.length > 0 ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            Posting is unavailable while this run has blocking exceptions.
          </p>
        </Card>
      ) : current ? (
        <PostRunForm
          org={org}
          runId={runId}
          previewVersion={run.preview_version}
          defaultIssueDate={run.period_start}
          lineCount={current.billableLineCount}
          totalLabel={formatMoney(current.totalMinor, current.currencyCode)}
        />
      ) : null}

      {/* ------------------------------------------------- what it raised */}

      <section aria-labelledby="documents" className="space-y-3">
        <h2 id="documents" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          {run.status === 'posted' ? 'Charges raised' : 'Charges this run would raise'}
        </h2>

        {run.status === 'posted' ? (
          documents.length === 0 ? (
            <EmptyState
              title="This run raised nothing"
              description="Every line was already billed for its schedule and period, so the run posted no new charge. That is the duplicate guard working, not a failure."
            />
          ) : (
            <DataTable
              caption="Charges raised by this run"
              head={
                <tr>
                  <Th>Document</Th><Th>Resident</Th><Th>Unit</Th>
                  <Th>Issued</Th><Th>Due</Th><Th numeric>Amount</Th>
                </tr>
              }
            >
              {documents.map((d) => (
                <tr key={d.id} className="hover:bg-ink-50">
                  <Td className="tabular">{d.document_number}</Td>
                  <Td>{d.resident_name ?? '—'}</Td>
                  <Td className="text-ink-500">{d.unit_label}</Td>
                  <Td className="whitespace-nowrap text-ink-500">
                    {formatDate(d.issue_date, context.timeZone)}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-500">
                    {formatDate(d.due_date, context.timeZone)}
                  </Td>
                  <Td numeric>
                    <Money minor={BigInt(d.total_minor)} currency={d.currency_code} />
                  </Td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-200 font-semibold">
                <Td>Total</Td><Td>{null}</Td><Td>{null}</Td><Td>{null}</Td><Td>{null}</Td>
                <Td numeric><Money minor={postedTotal} currency={currency} emphasise /></Td>
              </tr>
            </DataTable>
          )
        ) : current ? (
          <DataTable
            caption="Charges this run would raise"
            head={
              <tr>
                <Th>Lease</Th><Th>Unit</Th><Th>Charge</Th>
                <Th>Due</Th><Th>Proration</Th><Th numeric>Amount</Th>
              </tr>
            }
          >
            {current.lines.filter((l) => !l.alreadyBilled).map((l) => (
              <tr key={`${l.scheduleId}-${l.dueDate}`} className="hover:bg-ink-50">
                <Td className="tabular">{l.leaseReference}</Td>
                <Td className="text-ink-500">{l.unitLabel}</Td>
                <Td>{l.description}</Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDate(l.dueDate, context.timeZone)}
                </Td>
                <Td className="text-ink-500">
                  {l.prorated
                    ? `${l.prorationNumerator}/${l.prorationDenominator} days`
                    : 'full month'}
                </Td>
                <Td numeric><Money minor={l.amountMinor} currency={current.currencyCode} /></Td>
              </tr>
            ))}
            <tr className="border-t-2 border-ink-200 font-semibold">
              <Td>Total</Td><Td>{null}</Td><Td>{null}</Td><Td>{null}</Td><Td>{null}</Td>
              <Td numeric>
                <Money minor={current.totalMinor} currency={current.currencyCode} emphasise />
              </Td>
            </tr>
          </DataTable>
        ) : null}
      </section>
    </div>
  );
}
