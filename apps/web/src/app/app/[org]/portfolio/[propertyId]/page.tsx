import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMoney } from '@propertyos/domain/money';
import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadPropertyDetail } from '@/lib/operations-queries';

export const metadata = { title: 'Property' };
export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  house: 'House', cottage: 'Cottage', apartment: 'Apartment',
  apartment_block: 'Apartment block', townhouse: 'Townhouse', other: 'Other',
};

const LEASE_TONE: Record<string, StatusTone> = {
  active: 'positive', notice_given: 'caution', awaiting_execution: 'info',
};

/**
 * One property, and what is happening in each of its units.
 *
 * The Portfolio table has linked every property name here since it was built and
 * nothing answered: every one of those links was a 404. This is the page they
 * were pointing at — what the unit is, who is in it, what rent the lease
 * carries, and anything open on maintenance.
 *
 * Deliberately read-only. Editing a property, retiring a unit and changing rent
 * each have consequences a form on a summary page would hide, so none of them is
 * bolted on here.
 */
export default async function PropertyPage({
  params,
}: {
  params: Promise<{ org: string; propertyId: string }>;
}) {
  const { org, propertyId } = await params;
  const context = await requireOperator(org);
  const detail = await readAs(context.viewer, (tx) =>
    loadPropertyDetail(tx, context.organisationId, propertyId),
  );
  // A property outside this operator's scope reads exactly like one that does
  // not exist. RLS already made that decision; this only renders it.
  if (!detail) notFound();

  const { property, units, tickets } = detail;
  const occupied = units.filter((u) => u.lease_id).length;
  const address = [
    property.address_line1, property.address_line2, property.suburb,
    property.city, property.province, property.postal_code,
  ].filter(Boolean).join(', ');

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/portfolio`} className="text-sm text-spike-600 hover:underline">
        ← All properties
      </Link>

      <PageHeader
        title={property.name}
        description={address || 'No address recorded.'}
        actions={
          <Link
            href={`/app/${org}/maintenance/new`}
            className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700"
          >
            Log a request
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone={property.status === 'active' ? 'positive' : 'neutral'}>
          {property.status}
        </StatusBadge>
        <span className="text-ink-500">
          {TYPE_LABEL[property.property_type] ?? property.property_type}
        </span>
        <span className="tabular text-ink-400">{property.code}</span>
        <span className="text-ink-500">
          {occupied} of {units.length} {units.length === 1 ? 'unit' : 'units'} let
        </span>
        {property.municipal_account_ref ? (
          <span className="text-ink-400">Municipal account {property.municipal_account_ref}</span>
        ) : null}
      </div>

      {units.length === 0 ? (
        <EmptyState
          title="No units on this property"
          description="A property needs at least one rentable unit before a lease can be drafted against it. A house normally has a single unit."
        />
      ) : (
        <DataTable
          caption={`Units at ${property.name}`}
          head={
            <tr>
              <Th>Unit</Th><Th>Type</Th><Th>Beds</Th><Th>Occupant</Th>
              <Th>Lease</Th><Th numeric>Rent</Th><Th numeric>Advertised</Th>
            </tr>
          }
        >
          {units.map((u) => (
            <tr key={u.id} className="hover:bg-ink-50">
              <Td>
                <span className="font-medium text-ink-900">{u.code}</span>
                {u.description ? (
                  <span className="block text-xs text-ink-400">{u.description}</span>
                ) : null}
              </Td>
              <Td className="capitalize text-ink-500">{u.rentable_type.replace(/_/g, ' ')}</Td>
              <Td className="tabular text-ink-500">{u.bedrooms ?? '—'}</Td>
              <Td className="text-ink-700">{u.resident_name || '—'}</Td>
              <Td>
                {u.lease_id && u.lease_reference ? (
                  <>
                    <Link
                      href={`/app/${org}/leases/${u.lease_id}`}
                      className="font-medium text-spike-600 hover:underline"
                    >
                      {u.lease_reference}
                    </Link>
                    <span className="ml-1.5 align-middle">
                      <StatusBadge tone={LEASE_TONE[u.lease_status ?? ''] ?? 'neutral'}>
                        {(u.lease_status ?? '').replace(/_/g, ' ')}
                      </StatusBadge>
                    </span>
                  </>
                ) : (
                  <StatusBadge tone="caution" glyph="○">Vacant</StatusBadge>
                )}
              </Td>
              {/* The rent the lease actually carries, and separately what the
                  unit is advertised at. Showing one as the other would misstate
                  the receivable. */}
              <Td numeric className="tabular">
                {u.rent_minor ? formatMoney(u.rent_minor, context.currencyCode) : '—'}
              </Td>
              <Td numeric className="tabular text-ink-500">
                {u.advertised_rent_minor
                  ? formatMoney(u.advertised_rent_minor, context.currencyCode)
                  : '—'}
              </Td>
            </tr>
          ))}
        </DataTable>
      )}

      <Card className="p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Open maintenance
        </h2>
        {tickets.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">
            Nothing open on this property. Resolved, closed and cancelled requests are on the
            Maintenance screen.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {tickets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href={`/app/${org}/maintenance/${t.id}`}
                  className="font-medium text-spike-600 hover:underline"
                >
                  {t.reference}
                </Link>
                {t.unit_code ? <span className="text-ink-400">{t.unit_code}</span> : null}
                <span className="capitalize text-ink-700">{t.category.replace(/_/g, ' ')}</span>
                <StatusBadge tone={t.urgency === 'emergency' || t.urgency === 'high' ? 'caution' : 'neutral'}>
                  {t.urgency}
                </StatusBadge>
                <StatusBadge tone="info">{t.status.replace(/_/g, ' ')}</StatusBadge>
                <span className="text-xs text-ink-400">
                  {formatDate(t.created_at, context.timeZone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
