import Link from 'next/link';
import { Card, DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { formatMinor } from '@propertyos/domain';
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
 * A statement a landlord exported themselves can now be imported, and its
 * lines are identified from the Bank statements screen. There is still no bank
 * FEED and no automatic matching: a line is evidence money arrived, and who it
 * came from is a judgement somebody makes.
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
  const { unmatched, evidence, leases } = await readAs(context.viewer, async (tx) => ({
    ...(await loadReconciliation(tx, context.organisationId)),
    leases: await loadLeaseChoices(tx, context.organisationId),
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

  const showUnmatched = filter !== 'evidence';
  const showEvidence = filter !== 'unmatched';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description="Receipts not yet applied to a charge, and resident payment claims not yet verified."
        actions={
          <RecordReceiptForm org={org} leases={leases} today={today} prefill={prefill} />
        }
      />

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-ink-700">
          Working from a bank statement? Import it and identify each line there. Importing
          creates no receipt and moves no balance.
        </p>
        <Link
          href={`/app/${org}/reconciliation/statements`}
          className="whitespace-nowrap rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-spike-600"
        >
          Bank statements →
        </Link>
      </Card>

      {filter ? (
        <Link href={`/app/${org}/reconciliation`} className="inline-block text-sm text-spike-700">
          ← Show everything
        </Link>
      ) : null}

      {showUnmatched ? (
        <section aria-labelledby="unmatched" className="space-y-3">
          <h2 id="unmatched" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Received but not applied
          </h2>
          {unmatched.length === 0 ? (
            <EmptyState
              title="Every receipt is applied"
              description="Money received has been allocated to charges. Nothing is sitting in suspense."
            />
          ) : (
            <DataTable
              caption="Receipts with an unapplied balance"
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
                  <Td className="tabular">
                    <Link
                      href={`/app/${org}/reconciliation/${r.receipt_id}`}
                      className="font-medium text-spike-600 hover:underline"
                    >
                      {r.receipt_number}
                    </Link>
                  </Td>
                  <Td>{r.lease_reference ?? '—'}</Td>
                  <Td>
                    {r.in_suspense ? (
                      <StatusBadge tone="caution" glyph="◐">In suspense</StatusBadge>
                    ) : null}
                  </Td>
                  <Td numeric><Money minor={BigInt(r.amount_minor)} currency={r.currency_code} /></Td>
                  <Td numeric>
                    <Money minor={BigInt(r.unapplied_minor)} currency={r.currency_code} emphasise />
                  </Td>
                  <Td>
                    <Link
                      href={`/app/${org}/reconciliation/${r.receipt_id}`}
                      className="text-sm font-medium text-spike-600 hover:underline"
                    >
                      {r.in_suspense ? 'Identify →' : 'Apply →'}
                    </Link>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
      ) : null}

      {showEvidence ? (
        <section aria-labelledby="evidence" className="space-y-3">
          <h2 id="evidence" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Payment claims awaiting verification
          </h2>
          <p className="text-sm text-ink-500">
            Evidence a resident uploaded. It has <strong>not</strong> reduced any balance and will
            not until the funds are confirmed against the bank record and a receipt is created.
          </p>
          {evidence.length === 0 ? (
            <EmptyState
              title="Nothing awaiting verification"
              description="Proof of payment uploaded by a resident appears here for checking."
            />
          ) : (
            <DataTable
              caption="Payment evidence awaiting verification"
              head={
                <tr>
                  <Th>Submitted</Th><Th>Resident</Th><Th>Lease</Th>
                  <Th>Reference</Th><Th>Claimed paid</Th><Th numeric>Claimed</Th>
                  <Th><span className="sr-only">Action</span></Th>
                </tr>
              }
            >
              {evidence.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-ink-500">
                    {formatDate(e.submitted_at, context.timeZone)}
                  </Td>
                  <Td>{e.resident_name ?? '—'}</Td>
                  <Td>
                    {e.lease_reference ?? '—'}
                  </Td>
                  <Td className="tabular text-ink-500">{e.reference ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-ink-500">
                    {e.claimed_paid_at ? formatDate(e.claimed_paid_at, context.timeZone) : '—'}
                  </Td>
                  <Td numeric>
                    <Money minor={BigInt(e.claimed_amount_minor)} currency={context.currencyCode} />
                  </Td>
                  <Td>
                    <ReviewEvidenceForm
                      org={org} evidenceId={e.id} leaseReference={e.lease_reference}
                    />
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
      ) : null}

      <Card className="p-4">
        <p className="text-sm font-medium text-ink-900">No bank feed is connected</p>
        <p className="mt-1 text-sm text-ink-500">
          Importing a bank statement and matching transactions automatically is not built, so
          every receipt here was entered by a person who saw the money in the account. That is
          deliberate: nothing in PropertyOS invents a receipt, and nothing turns a resident&rsquo;s
          claim into one.
        </p>
      </Card>
    </div>
  );
}
