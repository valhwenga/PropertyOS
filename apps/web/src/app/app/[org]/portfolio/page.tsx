import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { loadProperties } from '@/lib/queries';

export const metadata = { title: 'Portfolio' };
export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  house: 'House', cottage: 'Cottage', apartment: 'Apartment',
  apartment_block: 'Apartment block', townhouse: 'Townhouse', other: 'Other',
};

export default async function PortfolioPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const properties = await readAs(context.viewer, (tx) => loadProperties(tx, context.organisationId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        description="Properties in your assigned scope. A house needs no building; a block can hold many units."
        actions={
          <Link href={`/app/${org}/portfolio/new`} className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Add property
          </Link>
        }
      />

      {properties.length === 0 ? (
        <EmptyState
          title="No properties in your scope"
          description="Either none have been added yet, or your roles are scoped to properties that do not include any. An organisation administrator can change your scope."
          action={
            <Link href={`/app/${org}/portfolio/new`} className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
              Add a property
            </Link>
          }
        />
      ) : (
        <DataTable
          caption="Properties in scope"
          head={
            <tr>
              <Th>Property</Th><Th>Code</Th><Th>Type</Th><Th>City</Th>
              <Th numeric>Units</Th><Th numeric>Occupied</Th><Th>Status</Th>
            </tr>
          }
        >
          {properties.map((p) => {
            const units = Number(p.unit_count);
            const occupied = Number(p.occupied_count);
            const vacant = units - occupied;
            return (
              <tr key={p.id} className="hover:bg-ink-50">
                <Td>
                  <Link href={`/app/${org}/portfolio/${p.id}`} className="font-medium text-spike-600 hover:underline">
                    {p.name}
                  </Link>
                </Td>
                <Td className="tabular text-ink-500">{p.code}</Td>
                <Td>{TYPE_LABEL[p.property_type] ?? p.property_type}</Td>
                <Td className="text-ink-500">{p.city}</Td>
                <Td numeric className="tabular">{units}</Td>
                <Td numeric className="tabular">{occupied}</Td>
                <Td>
                  {vacant === 0 ? (
                    <StatusBadge tone="positive" glyph="●">Fully occupied</StatusBadge>
                  ) : (
                    <StatusBadge tone="caution" glyph="○">{vacant} vacant</StatusBadge>
                  )}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}
