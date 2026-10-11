import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { formatMinor, getPropertyDetails, hasPermission } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { loadPropertyDetail } from '@/lib/operations-queries';
import {
  EditUnitForm, ReinstateUnitForm, RetireUnitForm,
} from '../../edit/portfolio-forms';

export const metadata = { title: 'Edit unit' };
export const dynamic = 'force-dynamic';

/**
 * One unit: its details, and whether it can be taken out of use.
 *
 * The page refuses before the operator fills anything in. A unit with a live
 * lease on it says which lease and why, rather than accepting a reason and
 * then rejecting it — "do not silently retire occupied units" is better served
 * by never offering to.
 */
export default async function UnitPage({
  params,
}: {
  params: Promise<{ org: string; propertyId: string; unitId: string }>;
}) {
  const { org, propertyId, unitId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => ({
    detail: await loadPropertyDetail(tx, context.organisationId, propertyId),
    property: await getPropertyDetails(tx, context.organisationId, propertyId),
    canUpdate: await hasPermission(tx, context.organisationId, 'property.update'),
  }));
  if (!data.detail || !data.property) notFound();

  const unit = data.detail.units.find((u) => u.id === unitId);
  if (!unit) notFound();
  const { property, canUpdate } = data;

  const occupiedBy = unit.lease_id && unit.lease_status
    ? { reference: unit.lease_reference ?? 'a lease', status: unit.lease_status }
    : null;

  return (
    <div className="space-y-6">
      <Link
        href={`/app/${org}/portfolio/${propertyId}`}
        className="text-sm text-spike-600 hover:underline"
      >
        ← {property.name}
      </Link>

      <PageHeader
        title={`Unit ${unit.code}`}
        description={`${property.name} · ${unit.rentable_type.replace(/_/g, ' ')}`}
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={unit.status === 'active' ? 'positive' : 'neutral'}>
            {unit.status === 'active' ? 'in use' : 'retired'}
          </StatusBadge>
          {occupiedBy ? (
            <span className="text-sm text-ink-700">
              Lease{' '}
              <Link
                href={`/app/${org}/leases/${unit.lease_id}`}
                className="text-spike-600 hover:underline"
              >
                {occupiedBy.reference}
              </Link>{' '}
              is {occupiedBy.status.replace(/_/g, ' ')}
              {unit.resident_name ? ` · ${unit.resident_name}` : ''}
            </span>
          ) : (
            <span className="text-sm text-ink-500">No live lease on this unit.</span>
          )}
        </div>
      </Card>

      {canUpdate ? (
        <>
          <EditUnitForm
            org={org} propertyId={propertyId} unitId={unitId}
            currencyCode={context.currencyCode}
            unit={{
              code: unit.code,
              description: unit.description,
              rentableType: unit.rentable_type,
              bedrooms: unit.bedrooms === null ? '' : String(unit.bedrooms),
              bathrooms: unit.bathrooms ?? '',
              floor: unit.floor,
              floorAreaSqm: unit.floor_area_sqm ?? '',
              advertisedRentMajor: unit.advertised_rent_minor
                ? formatMinor(BigInt(unit.advertised_rent_minor), context.currencyCode)
                  .replace(/,/g, '')
                : '',
            }}
          />

          <section aria-labelledby="unit-use" className="space-y-3">
            <h2
              id="unit-use"
              className="text-sm font-semibold uppercase tracking-wide text-ink-500"
            >
              Taking it out of use
            </h2>
            {unit.status === 'active' ? (
              <RetireUnitForm
                org={org} propertyId={propertyId} unitId={unitId} unitCode={unit.code}
                occupiedBy={occupiedBy}
              />
            ) : (
              <ReinstateUnitForm
                org={org} propertyId={propertyId} unitId={unitId}
                propertyArchived={property.status === 'archived'}
              />
            )}
          </section>
        </>
      ) : (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            Editing a unit needs the property update permission.
          </p>
        </Card>
      )}
    </div>
  );
}
