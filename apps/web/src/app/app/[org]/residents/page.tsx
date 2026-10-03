import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { loadResidents } from '@/lib/queries';

export const metadata = { title: 'Residents' };
export const dynamic = 'force-dynamic';

export default async function ResidentsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const residents = await readAs(context.viewer, (tx) => loadResidents(tx, context.organisationId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Residents"
        description="People renting from you. A resident can exist without ever activating a portal account."
        actions={
          <Link href={`/app/${org}/residents/new`} className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Add resident
          </Link>
        }
      />

      {residents.length === 0 ? (
        <EmptyState
          title="No residents yet"
          description="Add a resident profile before drafting their lease. Contact details and a portal invitation can follow later."
        />
      ) : (
        <DataTable
          caption="Resident profiles"
          head={
            <tr>
              <Th>Name</Th><Th>Contact</Th><Th>Identity</Th>
              <Th numeric>Leases</Th><Th>Portal</Th><Th>Status</Th>
            </tr>
          }
        >
          {residents.map((r) => (
            <tr key={r.id} className="hover:bg-ink-50">
              <Td>
                <Link href={`/app/${org}/residents/${r.id}`} className="font-medium text-spike-600 hover:underline">
                  {r.first_name} {r.last_name}
                </Link>
              </Td>
              <Td className="text-ink-500">{r.email ?? r.phone ?? '—'}</Td>
              {/* Identity numbers are masked in list views by design. */}
              <Td className="tabular text-ink-400">
                {r.identity_number_last4 ? `••••••• ${r.identity_number_last4}` : '—'}
              </Td>
              <Td numeric className="tabular">{r.lease_count}</Td>
              <Td>
                {r.has_portal
                  ? <StatusBadge tone="positive" glyph="●">Active</StatusBadge>
                  : <StatusBadge tone="neutral" glyph="○">No login</StatusBadge>}
              </Td>
              <Td className="capitalize text-ink-500">{r.status}</Td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
