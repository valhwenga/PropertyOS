import Link from 'next/link';
import {
  DataTable, Disclosure, EmptyState, Money, PageHeader, Panel, StatusBadge,
  Tabs, Td, Th, buttonClass,
} from '@propertyos/ui';
import { formatMinor, listBankLines } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadLeaseChoices, loadReconciliation } from '@/lib/operations-queries';
import { RecordReceiptForm, ReviewEvidenceForm } from './record-receipt-form';

export const metadata = { title: 'Reconciliation' };
export const dynamic = 'force-dynamic';

/**
 * What is waiting to be tied to a charge.
 *
 * Two different things, kept apart because they mean different things to the
 * ledger. Money the organisation has actually received but not yet applied is
 * real: it sits in suspense and is owed somewhere. A resident's proof of
 * payment is a CLAIM, carries no ledger effect at all, and must not be read as
 * money in hand until it is verified against the bank record.
 *
 * The tabs are links, not client state, so the overview's tiles can point
 * straight at one queue — which they do. Absent the parameter both queues are
 * shown, because on a quiet day the whole of reconciliation fits on a screen.
 *
 * On what is and is not automated, see the disclosure at the foot of the page;
 * it is the one place that describes the capability, so there is nowhere for a
 * second, staler description to contradict it.
 */
export default async function ReconciliationPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{
    filter?: string; lease?: string; amount?: string; bankLine?: string; on?: string;
    reference?: string;
  }>;
}) {
  const { org } = await params;
  const { filter, lease, amount, bankLine, on, reference } = await searchParams;
  const context = await requireOperator(org);
  const { unmatched, evidence, everRecordedAReceipt, everReceivedEvidence, leases, openLines } =
    await readAs(context.viewer, async (tx) => ({
      ...(await loadReconciliation(tx, context.organisationId)),
      leases: await loadLeaseChoices(tx, context.organisationId),
      openLines: (await listBankLines(tx, context.organisationId, { onlyUnmatched: true })).length,
    }));
  const today = new Date().toISOString().slice(0, 10);

  // Arrived from a statement line: the bank's own figures are carried over so
  // they are not retyped, and the amount is converted back to major units for
  // the form. A lease that is not this organisation's would simply not be in
  // the list, and the command checks it again regardless.
  const prefill = bankLine
    ? {
        bankTransactionId: bankLine,
        leaseId: lease && leases.some((l) => l.id === lease) ? lease : undefined,
        amountMajor: amount && /^\d+$/.test(amount)
          ? formatMinor(BigInt(amount), context.currencyCode).replace(/,/g, '')
          : undefined,
        receivedOn: on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : undefined,
        payerReference: reference ? reference.slice(0, 140) : undefined,
      }
    : undefined;

  const base = `/app/${org}/reconciliation`;
  const current = filter === 'unmatched' || filter === 'evidence' ? filter : 'all';
  const showUnmatched = current !== 'evidence';
  const showEvidence = current !== 'unmatched';

  const inSuspense = unmatched.filter((r) => r.in_suspense).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reconciliation"
        description="Money received that is not yet on a charge, and resident payment claims not yet verified."
        meta={
          <>
            <span>
              {inSuspense > 0
                ? `${inSuspense} receipt${inSuspense === 1 ? '' : 's'} in suspense`
                : 'Nothing in suspense'}
            </span>
            <span aria-hidden="true">·</span>
            <span>Times in {context.timeZone}</span>
          </>
        }
        actions={
          <>
            <Link href={`${base}/statements`} className={buttonClass('secondary')}>
              Bank statements →
            </Link>
            <RecordReceiptForm org={org} leases={leases} today={today} prefill={prefill} />
          </>
        }
      />

      <Tabs
        label="Reconciliation queues"
        current={current}
        tabs={[
          { key: 'all', label: 'Everything', href: base },
          {
            key: 'unmatched',
            label: 'Not applied',
            href: `${base}?filter=unmatched`,
            count: unmatched.length,
          },
          {
            key: 'evidence',
            label: 'Payment evidence',
            href: `${base}?filter=evidence`,
            count: evidence.length,
          },
          {
            key: 'statements',
            label: 'Statement lines',
            href: `${base}/statements`,
            count: openLines,
          },
        ]}
      />

      {/* The capability, said once and said plainly, where somebody deciding
          what to do next will read it. The disclosure at the foot carries the
          detail; this is the sentence that must not be missed. */}
      <p className="text-[length:var(--text-table)] text-ink-500">
        Statement lines come from a CSV you export from your own bank — importing creates no
        receipt and moves no balance. No bank feed is connected.
      </p>

      {showUnmatched ? (
        <Panel
          title="Received but not applied"
          titleId="unmatched"
          description="Money in the account that is not yet sitting on a charge."
        >
          {unmatched.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={everRecordedAReceipt ? 'Every receipt is applied' : 'No receipts recorded yet'}
                description={
                  everRecordedAReceipt
                    ? 'Money received has been allocated to charges. Nothing is sitting in suspense.'
                    : 'Record money once you have seen it in the bank account, or import a statement and identify its lines.'
                }
              />
            </div>
          ) : (
            <DataTable
              caption="Receipts with an unapplied balance"
              stickyHead
              head={
                <tr>
                  <Th>Received</Th><Th>Receipt</Th><Th>Lease</Th>
                  <Th>State</Th><Th numeric>Received</Th><Th numeric>Unapplied</Th>
                  <Th><span className="sr-only">Action</span></Th>
                </tr>
              }
            >
              {unmatched.map((r) => (
                <tr key={r.receipt_id}>
                  <Td className="whitespace-nowrap text-ink-500">
                    {formatDate(r.received_on, context.timeZone)}
                  </Td>
                  <Td>
                    <Link
                      href={`${base}/${r.receipt_id}`}
                      className="technical font-medium text-spike-600 hover:underline"
                    >
                      {r.receipt_number}
                    </Link>
                  </Td>
                  <Td className="technical text-ink-700">{r.lease_reference ?? '—'}</Td>
                  <Td>
                    {r.in_suspense ? (
                      <StatusBadge tone="caution">In suspense</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">Partly applied</StatusBadge>
                    )}
                  </Td>
                  <Td numeric><Money minor={BigInt(r.amount_minor)} currency={r.currency_code} /></Td>
                  <Td numeric>
                    <Money
                      minor={BigInt(r.unapplied_minor)} currency={r.currency_code}
                      emphasise tone="plain"
                    />
                  </Td>
                  <Td>
                    <Link
                      href={`${base}/${r.receipt_id}`}
                      className="text-[length:var(--text-table)] font-medium text-spike-600 hover:underline"
                    >
                      {r.in_suspense ? 'Identify →' : 'Apply →'}
                    </Link>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      ) : null}

      {showEvidence ? (
        <Panel
          title="Payment evidence awaiting verification"
          titleId="evidence"
          description="A claim a resident uploaded. It has not reduced any balance and will not until the funds are confirmed against the bank record and a receipt is recorded."
        >
          {evidence.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                title={
                  everReceivedEvidence
                    ? 'Nothing awaiting verification'
                    : 'No resident has uploaded proof of payment'
                }
                description={
                  everReceivedEvidence
                    ? 'Every claim submitted has been reviewed.'
                    : 'Proof of payment uploaded from the resident portal appears here for checking.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {evidence.map((e) => (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0">
                      <p className="text-[length:var(--text-body)] font-medium text-ink-900">
                        {e.resident_name ?? 'Unnamed resident'}
                      </p>
                      <p className="text-[length:var(--text-meta)] text-ink-500">
                        <span className="technical">{e.lease_reference ?? 'No lease'}</span>
                        {' · submitted '}
                        {formatDate(e.submitted_at, context.timeZone)}
                        {e.claimed_paid_at
                          ? ` · claims paid ${formatDate(e.claimed_paid_at, context.timeZone)}`
                          : ''}
                        {e.reference ? ' · ' : ''}
                        {e.reference ? <span className="technical">{e.reference}</span> : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="tabular text-[length:var(--text-body)] font-semibold text-ink-700">
                        <Money
                          minor={BigInt(e.claimed_amount_minor)}
                          currency={context.currencyCode}
                          tone="plain"
                        />
                      </span>
                      <span className="text-[length:var(--text-meta)] text-ink-500">claimed</span>
                    </div>
                  </div>
                  <ReviewEvidenceForm
                    org={org} evidenceId={e.id} leaseReference={e.lease_reference}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <Disclosure summary="What is automated here, and what is not">
        <ul className="space-y-2">
          <li>
            <strong className="font-semibold text-ink-900">Importing a statement: yes.</strong>{' '}
            A CSV you export from your own bank is previewed, then imported on{' '}
            <Link href={`${base}/statements`} className="text-spike-600 hover:underline">
              Bank statements
            </Link>
            . Importing creates no receipt and moves no balance — a line is evidence that money
            arrived, and an overlapping statement is refused rather than counted twice.
          </li>
          <li>
            <strong className="font-semibold text-ink-900">
              Suggesting who paid: yes, as suggestions.
            </strong>{' '}
            Asked for a line, PropertyOS looks for a resident&rsquo;s name or a lease reference in
            the bank&rsquo;s description and in payments already recorded, and says in words why
            each candidate is offered. It never records the receipt for you.
          </li>
          <li>
            <strong className="font-semibold text-ink-900">A live bank feed: no.</strong>{' '}
            No bank is contacted and no integration is connected. Every receipt on this page was
            entered by a person who saw the money in the account. That is deliberate: nothing
            invents a receipt, and nothing turns a resident&rsquo;s claim into one.
          </li>
        </ul>
      </Disclosure>
    </div>
  );
}
