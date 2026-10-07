import { DataTable, EmptyState, Money, PageHeader, Td, Th } from '@propertyos/ui';
import { depositRegister } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';

export const metadata = { title: 'Deposits' };
export const dynamic = 'force-dynamic';

/**
 * Deposit liabilities.
 *
 * A deposit is money held for the resident, not income. It is never netted off
 * the rent receivable, which is why this is its own register rather than a
 * column on a statement.
 */
export default async function DepositsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const data = await readAs(context.viewer, (tx) =>
    depositRegister(tx, context.organisationId));
  const currency = data.meta.currencyCode;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deposits"
        description="Deposits held against each lease, with what is required, what is held, interest credited, and anything deducted or refunded."
      />

      <div className="rounded-[var(--radius-card)] border border-ink-100 bg-surface p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Total held</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight">
          <Money minor={data.totalHeldMinor} currency={currency} />
        </p>
        <p className="mt-2 text-sm text-ink-500">
          Held on behalf of residents. This is a liability and does not reduce any rent receivable.
        </p>
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title="No deposits recorded"
          description="Deposit liabilities appear here once a deposit is received against a lease."
        />
      ) : (
        <DataTable
          caption="Deposit register"
          head={
            <tr>
              <Th>Resident</Th><Th>Unit</Th><Th>Holder</Th>
              <Th numeric>Required</Th><Th numeric>Held</Th><Th numeric>Interest</Th>
              <Th numeric>Deductions</Th><Th numeric>Refunded</Th>
            </tr>
          }
        >
          {data.rows.map((r, i) => (
            <tr key={`${r.leaseReference}-${i}`}>
              <Td>{r.residentName ?? r.leaseReference}</Td>
              <Td className="text-ink-500">{r.unitLabel}</Td>
              <Td className="capitalize">{r.holder.replace(/_/g, ' ')}</Td>
              <Td numeric><Money minor={r.requiredMinor} currency={currency} /></Td>
              <Td numeric><Money minor={r.heldMinor} currency={currency} emphasise /></Td>
              <Td numeric><Money minor={r.interestCreditedMinor} currency={currency} /></Td>
              <Td numeric><Money minor={r.deductionsMinor} currency={currency} /></Td>
              <Td numeric><Money minor={r.refundedMinor} currency={currency} /></Td>
            </tr>
          ))}
        </DataTable>
      )}

      {data.meta.qualifications.length > 0 ? (
        <ul className="space-y-1 text-xs text-ink-500">
          {data.meta.qualifications.map((q) => <li key={q}>{q}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
