import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, DataTable, Money, StatusBadge, Td, Th } from '@propertyos/ui';
import { buildStatement, DomainError } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

export default async function ResidentLeasePage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();

  // The resident's reachable leases come from their own portal links. Changing
  // the id in the URL to another lease simply does not resolve.
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) notFound();

  const data = await readAs(viewer, async (tx) => {
    const [lease] = await tx<
      { reference: string; unit_label: string; status: string; end_date: string | null }[]
    >`
      select l.reference, l.status::text, l.end_date::text,
             p.name || ' / ' || u.code as unit_label
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      where l.id = ${leaseId}::uuid
    `;
    if (!lease) return null;

    const documents = await tx<{ id: string; title: string; classification: string }[]>`
      select id, title, classification from documents
      where lease_id = ${leaseId}::uuid and visibility = 'resident_shared'
        and quarantined = false and deleted_at is null
      order by uploaded_at desc
    `;

    try {
      const statement = await buildStatement(tx, link.organisationId, {
        leaseId,
        cutOff: new Date().toISOString().slice(0, 10),
      });
      return { lease, documents, statement };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });

  if (!data) notFound();
  const { lease, documents, statement } = data;
  const owing = statement.closingReceivableMinor > 0n;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{lease.unit_label}</h1>
        <p className="text-sm text-ink-500">Lease {lease.reference}</p>
      </div>

      {/* Amount due is the first thing on the screen, in a large, legible figure. */}
      <Card className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {owing ? 'Amount due' : 'Your account'}
        </p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          <Money minor={statement.closingReceivableMinor} currency={statement.currencyCode} />
        </p>
        <p className="mt-2 text-sm text-ink-500">
          {owing
            ? 'This is your outstanding balance from posted charges and payments applied to them.'
            : 'Nothing is outstanding on this lease.'}
        </p>

        {statement.unappliedCreditMinor > 0n ? (
          <p className="mt-3 rounded-lg bg-positive-50 px-3 py-2 text-sm text-positive-600">
            You have <Money minor={statement.unappliedCreditMinor} currency={statement.currencyCode} />{' '}
            in credit that has not yet been applied to a charge.
          </p>
        ) : null}

        {statement.depositHeldMinor > 0n ? (
          <p className="mt-3 text-sm text-ink-500">
            Deposit held: <Money minor={statement.depositHeldMinor} currency={statement.currencyCode} />.
            This is held separately and does not reduce the balance above.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/portal/${leaseId}/payments`}
                className="rounded-lg bg-spike-500 px-4 py-2.5 text-sm font-medium text-white">
            Upload proof of payment
          </Link>
          <Link href={`/portal/${leaseId}/maintenance/new`}
                className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-sm font-medium text-ink-700">
            Report a problem
          </Link>
        </div>
      </Card>

      {statement.pendingEvidence.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <StatusBadge tone="caution" glyph="◐">Awaiting verification</StatusBadge>
          <p className="mt-2 text-sm text-ink-700">
            We have received your proof of payment of{' '}
            <Money
              minor={statement.pendingEvidence.reduce((s, e) => s + e.claimedAmountMinor, 0n)}
              currency={statement.currencyCode}
            />
            . It is being checked against our bank records. Your balance above will only change
            once the payment is confirmed.
          </p>
        </Card>
      ) : null}

      <section aria-labelledby="statement-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="statement-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Statement
          </h2>
          {/* A resident needs a copy they can keep, forward to their bank, or
              take to an advice office. */}
          <a
            href={`/portal/${leaseId}/statement.pdf`}
            className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700"
          >
            Download PDF
          </a>
        </div>
        <DataTable
          caption={`Statement for lease ${lease.reference}`}
          dense
          head={
            <tr><Th>Date</Th><Th>Description</Th><Th numeric>Amount</Th><Th numeric>Balance</Th></tr>
          }
        >
          {statement.lines.map((line, index) => (
            <tr key={`${line.reference}-${index}`}>
              <Td className="whitespace-nowrap text-ink-500">{formatDate(line.entryDate)}</Td>
              <Td>
                <span className="block">{line.description}</span>
                <span className="tabular text-xs text-ink-400">{line.reference}</span>
              </Td>
              <Td numeric>
                {line.debitMinor > 0n ? (
                  <Money minor={line.debitMinor} currency={statement.currencyCode} />
                ) : (
                  <span className="text-positive-600">
                    −<Money minor={line.creditMinor} currency={statement.currencyCode} />
                  </span>
                )}
              </Td>
              <Td numeric>
                <Money minor={line.runningBalanceMinor} currency={statement.currencyCode} />
              </Td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section aria-labelledby="documents-heading" className="space-y-3">
        <h2 id="documents-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Your documents
        </h2>
        {documents.length === 0 ? (
          <Card className="px-4 py-6 text-center text-sm text-ink-500">
            No documents have been shared with you yet.
          </Card>
        ) : (
          <Card className="divide-y divide-ink-100">
            {documents.map((doc) => (
              <a key={doc.id} href={`/portal/${leaseId}/documents/${doc.id}`}
                 className="flex items-center justify-between px-4 py-3 hover:bg-ink-50">
                <div>
                  <p className="text-sm font-medium text-ink-900">{doc.title}</p>
                  <p className="text-xs capitalize text-ink-500">{doc.classification}</p>
                </div>
                <span aria-hidden="true" className="text-spike-500">↓</span>
              </a>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
