import Link from 'next/link';
import { Card, PageHeader } from '@propertyos/ui';
import { requireOperator } from '@/lib/auth';

export const metadata = { title: 'Reports' };

const REPORTS = [
  {
    slug: 'rent-roll', name: 'Rent roll',
    description: 'Every rentable unit with its lease in force, contracted rent, resident and outstanding balance.',
  },
  {
    slug: 'arrears', name: 'Arrears ageing',
    description: 'Unpaid balances bucketed by days past the due date. A partial payment keeps its original bucket.',
  },
  {
    slug: 'collection', name: 'Collection report',
    description: 'Billed against collected for a period. Counts only receipts actually allocated to that period’s charges.',
  },
  {
    slug: 'expenses', name: 'Expense report',
    description: 'Property costs with operating, capital and financing reported separately.',
  },
  {
    slug: 'deposits', name: 'Deposit register',
    description: 'Deposit liabilities with holder, evidence, deductions and refunds. Never mixed with rental income.',
  },
  {
    slug: 'lease-expiry', name: 'Lease expiry',
    description: 'Leases ending soon, with holdover occupancy and retained arrears shown separately.',
  },
  {
    slug: 'occupancy', name: 'Occupancy',
    description: 'Occupied unit days over available unit days, excluding days recorded out of service.',
  },
  {
    slug: 'journal-lines', name: 'Journal lines',
    description: 'The complete double-entry detail for a period, for your accountant to reconcile.',
  },
] as const;

export default async function ReportsIndex({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  await requireOperator(org);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Every report is computed from posted records within your assigned scope, and every export carries the filters and definitions that produced it."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <Link key={r.slug} href={`/app/${org}/reports/${r.slug}`} className="block">
            <Card className="h-full p-4 transition-colors hover:border-spike-300">
              <p className="font-medium text-ink-900">{r.name}</p>
              <p className="mt-1 text-sm text-ink-500">{r.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
