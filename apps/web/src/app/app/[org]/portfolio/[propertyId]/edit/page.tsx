import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { getPropertyDetails, hasPermission } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import {
  AddUnitForm, ArchivePropertyForm, EditPropertyForm, ReinstatePropertyForm,
} from './portfolio-forms';

export const metadata = { title: 'Edit property' };
export const dynamic = 'force-dynamic';

/**
 * Correcting a property, and taking it out of use.
 *
 * A separate page from the property summary because the two acts are not
 * alike: fixing a street name is a correction, and archiving a property is a
 * decision about the business. A form bolted onto a summary makes them look
 * the same.
 */
export default async function EditPropertyPage({
  params,
}: {
  params: Promise<{ org: string; propertyId: string }>;
}) {
  const { org, propertyId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => ({
    property: await getPropertyDetails(tx, context.organisationId, propertyId),
    canUpdate: await hasPermission(tx, context.organisationId, 'property.update'),
  }));
  if (!data.property) notFound();
  const { property, canUpdate } = data;

  if (!canUpdate) {
    return (
      <div className="space-y-6">
        <Link
          href={`/app/${org}/portfolio/${propertyId}`}
          className="text-sm text-spike-600 hover:underline"
        >
          ← {property.name}
        </Link>
        <PageHeader title={property.name} description="Editing the portfolio" />
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            You can see this property but not change it. Editing properties and units needs the
            property update permission.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/app/${org}/portfolio/${propertyId}`}
        className="text-sm text-spike-600 hover:underline"
      >
        ← {property.name}
      </Link>

      <PageHeader
        title={`Edit ${property.name}`}
        description={`${property.unitCount} ${property.unitCount === 1 ? 'unit' : 'units'}, `
          + `${property.activeUnitCount} active`
          + `${property.occupiedUnitCount > 0
            ? `, ${property.occupiedUnitCount} with a live lease` : ''}`}
      />

      {property.status === 'archived' ? (
        <Card className="border-ink-300 p-4">
          <StatusBadge tone="neutral">archived</StatusBadge>
          <p className="mt-2 text-sm text-ink-700">
            This property is out of use. Its history is intact and still appears in reports.
          </p>
        </Card>
      ) : null}

      <EditPropertyForm
        org={org} propertyId={propertyId}
        property={{
          name: property.name,
          code: property.code,
          propertyType: property.propertyType,
          addressLine1: property.addressLine1,
          addressLine2: property.addressLine2,
          suburb: property.suburb,
          city: property.city,
          province: property.province,
          postalCode: property.postalCode,
        }}
      />

      {property.status === 'active' ? (
        <section aria-labelledby="units" className="space-y-3">
          <h2 id="units" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Units
          </h2>
          <AddUnitForm
            org={org} propertyId={propertyId} currencyCode={context.currencyCode}
          />
        </section>
      ) : null}

      <section aria-labelledby="out-of-use" className="space-y-3">
        <h2
          id="out-of-use"
          className="text-sm font-semibold uppercase tracking-wide text-ink-500"
        >
          Taking it out of use
        </h2>
        {property.status === 'archived' ? (
          <ReinstatePropertyForm org={org} propertyId={propertyId} />
        ) : (
          <ArchivePropertyForm
            org={org} propertyId={propertyId} propertyName={property.name}
            activeUnitCount={property.activeUnitCount}
            occupiedUnitCount={property.occupiedUnitCount}
          />
        )}
      </section>
    </div>
  );
}
