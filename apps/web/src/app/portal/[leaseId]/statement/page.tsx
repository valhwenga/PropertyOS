import { notFound } from 'next/navigation';
import { Card, DataTable, Money, Td, Th } from '@propertyos/ui';
import { buildStatement, DomainError } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { SectionHeading } from '../section';

export const metadata = { title: 'Your statement' };
export const dynamic = 'force-dynamic';

/**
 * Every charge and every payment, in order, with the balance after each.
 *
 * The heaviest read in the portal, and now paid for only by the people who
 * came to look at it.
 */
export default async function StatementPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) notFound();

  const statement = await readAs(viewer, async (tx) => {
    try {
      return await buildStatement(tx, link.organisationId, {
        leaseId, cutOff: new Date().toISOString().slice(0, 10),
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });
  if (!statement) notFound();

  return (
    <section aria-labelledby="statement-heading" className="space-y-3">
      <SectionHeading
        id="statement-heading"
        action={
          <a
            href={`/portal/${leaseId}/statement.pdf`}
            className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm font-medium text-ink-700"
          >
            Download PDF
          </a>
        }
      >
        Statement
      </SectionHeading>

      {/* A phone first.
          `DataTable` is 640px wide at minimum and scrolls sideways inside its
          own box, which is right for an operator with a wide screen and wrong
          here: the two columns that matter — what it cost and what the balance
          became — were the two off the right-hand edge. Below `sm` the same
          lines are a list; from `sm` up, the table returns. */}
      <Card className="divide-y divide-ink-100 p-0 sm:hidden">
        {statement.lines.map((line, index) => (
          <div key={`m-${line.reference}-${index}`} className="flex gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-900">{line.description}</p>
              <p className="text-xs text-ink-400">
                {formatDate(line.entryDate)} · <span className="tabular">{line.reference}</span>
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium">
                {line.debitMinor > 0n ? (
                  <Money minor={line.debitMinor} currency={statement.currencyCode} />
                ) : (
                  <span className="text-positive-600">
                    −<Money minor={line.creditMinor} currency={statement.currencyCode} />
                  </span>
                )}
              </p>
              <p className="text-xs text-ink-400">
                balance <Money minor={line.runningBalanceMinor} currency={statement.currencyCode} />
              </p>
            </div>
          </div>
        ))}
      </Card>

      <div className="hidden sm:block">
        <DataTable
          caption={`Statement for lease ${statement.leaseReference}`}
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
      </div>

      <p className="text-xs text-ink-500">
        Built from posted records at today&rsquo;s date. A payment you have told us about is not
        on this statement until it has been confirmed against the bank record.
      </p>
    </section>
  );
}
