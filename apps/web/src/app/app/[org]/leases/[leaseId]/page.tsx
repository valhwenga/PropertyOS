import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Card, DataTable, Money, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import { buildStatement, DomainError } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Lease account' };
export const dynamic = 'force-dynamic';

export default async function LeaseDetailPage({
  params, searchParams,
}: {
  params: Promise<{ org: string; leaseId: string }>;
  searchParams: Promise<{ cutOff?: string }>;
}) {
  const { org, leaseId } = await params;
  const { cutOff } = await searchParams;
  const context = await requireOperator(org);
  const cut = cutOff ?? new Date().toISOString().slice(0, 10);

  const data = await readAs(context.viewer, async (tx) => {
    const [lease] = await tx<
      { id: string; reference: string; status: string; start_date: string; end_date: string | null;
        rent_minor: string; currency_code: string; unit_label: string; resident_name: string;
        deposit_required_minor: string; execution_exception_reason: string | null }[]
    >`
      select l.id, l.reference, l.status::text, l.start_date::text, l.end_date::text,
             l.rent_minor::text, l.currency_code, l.deposit_required_minor::text,
             l.execution_exception_reason,
             p.name || ' / ' || u.code as unit_label,
             coalesce(rp.first_name || ' ' || rp.last_name, '—') as resident_name
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
      where l.id = ${leaseId}::uuid and l.organisation_id = ${context.organisationId}::uuid
    `;
    if (!lease) return null;

    const parties = await tx<{ name: string; role: string; can_view_financials: boolean }[]>`
      select rp.first_name || ' ' || rp.last_name as name, lp.role::text, lp.can_view_financials
      from lease_parties lp
      join resident_profiles rp on rp.id = lp.resident_id
      where lp.lease_id = ${leaseId}::uuid and lp.removed_on is null
      order by lp.role
    `;

    try {
      const statement = await buildStatement(tx, context.organisationId, { leaseId, cutOff: cut });
      return { lease, parties, statement };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });

  if (!data) notFound();
  const { lease, parties, statement } = data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Lease ${lease.reference}`}
        description={`${lease.resident_name} · ${lease.unit_label}`}
        actions={
          <>
            <Link href={`/app/${org}/leases/${leaseId}/statement.csv?cutOff=${cut}`}
                  className="rounded-lg border border-ink-200 bg-white px-3.5 py-2 text-sm font-medium text-ink-700">
              Export CSV
            </Link>
            <Link href={`/app/${org}/reconciliation?lease=${leaseId}`}
                  className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
              Record a receipt
            </Link>
          </>
        }
      />

      {/* Summary. Receivable, credit and deposit are shown as three SEPARATE
          figures, because conflating them is how a resident gets told they owe
          nothing when they do. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Closing receivable</p>
          <p className="mt-1 text-2xl font-semibold">
            <Money minor={statement.closingReceivableMinor} currency={statement.currencyCode} />
          </p>
          <p className="mt-1 text-xs text-ink-400">As at {formatDate(cut, context.timeZone)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Unapplied credit</p>
          <p className="mt-1 text-2xl font-semibold">
            <Money minor={statement.unappliedCreditMinor} currency={statement.currencyCode} />
          </p>
          <p className="mt-1 text-xs text-ink-400">Overpayment held, not yet applied to a charge</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Deposit held</p>
          <p className="mt-1 text-2xl font-semibold">
            <Money minor={statement.depositHeldMinor} currency={statement.currencyCode} />
          </p>
          <p className="mt-1 text-xs text-ink-400">
            A separate liability. It does not reduce the receivable.
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Contracted rent</p>
          <p className="mt-1 text-2xl font-semibold">
            <Money minor={lease.rent_minor} currency={lease.currency_code} />
          </p>
          <p className="mt-1 text-xs text-ink-400">
            {formatDate(lease.start_date, context.timeZone)} –{' '}
            {lease.end_date ? formatDate(lease.end_date, context.timeZone) : 'open ended'}
          </p>
        </Card>
      </div>

      {statement.pendingEvidence.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            {statement.pendingEvidence.length} proof of payment awaiting verification
          </p>
          <p className="mt-1 text-sm text-ink-700">
            The resident has uploaded evidence totalling{' '}
            <Money
              minor={statement.pendingEvidence.reduce((s, e) => s + e.claimedAmountMinor, 0n)}
              currency={statement.currencyCode}
            />
            . This has <strong>not</strong> reduced the balance above and will not until the funds
            are confirmed against the bank record and a receipt is created.
          </p>
          <Link href={`/app/${org}/reconciliation?filter=evidence&lease=${leaseId}`}
                className="mt-2 inline-block text-sm font-medium text-spike-600 hover:underline">
            Review the evidence →
          </Link>
        </Card>
      ) : null}

      {lease.execution_exception_reason ? (
        <Card className="border-info-700/25 bg-info-50 p-4">
          <p className="text-sm font-semibold text-info-700">Activated without an attached contract</p>
          <p className="mt-1 text-sm text-ink-700">{lease.execution_exception_reason}</p>
        </Card>
      ) : null}

      <section aria-labelledby="parties-heading" className="space-y-3">
        <h2 id="parties-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Lease parties
        </h2>
        <Card className="divide-y divide-ink-100">
          {parties.map((p) => (
            <div key={`${p.name}-${p.role}`} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-ink-900">{p.name}</p>
                <p className="text-xs capitalize text-ink-500">{p.role.replace(/_/g, ' ')}</p>
              </div>
              {/* Joint parties share ONE rent receivable; the badge makes that
                  explicit so nobody expects a second invoice. */}
              {p.can_view_financials
                ? <StatusBadge tone="info" glyph="●">Sees shared financials</StatusBadge>
                : <StatusBadge tone="neutral" glyph="○">No financial access</StatusBadge>}
            </div>
          ))}
        </Card>
        <p className="text-xs text-ink-400">
          Joint parties share a single rent receivable on this lease. Adding a co-lessee never
          creates a second rent charge.
        </p>
      </section>

      <section aria-labelledby="statement-heading" className="space-y-3">
        <h2 id="statement-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Statement
        </h2>

        <DataTable
          caption={`Statement for lease ${lease.reference} to ${cut}`}
          head={
            <tr>
              <Th>Date</Th><Th>Reference</Th><Th>Description</Th>
              <Th numeric>Debit</Th><Th numeric>Credit</Th><Th numeric>Balance</Th>
            </tr>
          }
        >
          <tr className="bg-ink-50/60">
            <Td className="text-ink-500">—</Td>
            <Td className="text-ink-500">—</Td>
            <Td className="font-medium">
              Opening balance
              <span className="ml-2 text-xs text-ink-400">
                ({statement.openingBalanceSource === 'prior_activity'
                  ? 'from posted activity before this window'
                  : 'no prior activity'})
              </span>
            </Td>
            <Td numeric className="text-ink-400">—</Td>
            <Td numeric className="text-ink-400">—</Td>
            <Td numeric>
              <Money minor={statement.openingBalanceMinor} currency={statement.currencyCode} />
            </Td>
          </tr>

          {statement.lines.map((line, index) => (
            <tr key={`${line.reference}-${index}`} className="hover:bg-ink-50">
              <Td className="whitespace-nowrap text-ink-500">
                {formatDate(line.entryDate, context.timeZone)}
              </Td>
              <Td className="tabular text-ink-500">{line.reference}</Td>
              <Td>{line.description}</Td>
              <Td numeric>
                {line.debitMinor > 0n
                  ? <Money minor={line.debitMinor} currency={statement.currencyCode} />
                  : <span className="text-ink-300">—</span>}
              </Td>
              <Td numeric>
                {line.creditMinor > 0n
                  ? <Money minor={line.creditMinor} currency={statement.currencyCode} />
                  : <span className="text-ink-300">—</span>}
              </Td>
              <Td numeric>
                <Money minor={line.runningBalanceMinor} currency={statement.currencyCode} />
              </Td>
            </tr>
          ))}

          <tr className="border-t-2 border-ink-200 bg-ink-50/60 font-semibold">
            <Td> </Td><Td> </Td>
            <Td>Closing receivable</Td>
            <Td numeric> </Td><Td numeric> </Td>
            <Td numeric>
              <Money minor={statement.closingReceivableMinor} currency={statement.currencyCode} emphasise />
            </Td>
          </tr>
        </DataTable>

        <p className="text-xs text-ink-400">
          Generated {formatDate(statement.generatedAt, context.timeZone)} · cut off{' '}
          {formatDate(cut, context.timeZone)} · every line traces to a posted charge or a live
          allocation. Deposits and unverified payment evidence are excluded from this balance.
        </p>
      </section>
    </div>
  );
}
