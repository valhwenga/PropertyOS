import { PageHeader } from '@propertyos/ui';
import { BackLink } from '@/components/back-link';
import { requireOperator } from '@/lib/auth';
import { PropertyForm } from './property-form';

export const metadata = { title: 'Add a property' };
export const dynamic = 'force-dynamic';

export default async function NewPropertyPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackLink href={`/app/${org}/portfolio`} label="All properties" />

      <PageHeader
        title="Add a property"
        description="Everything but a block is created with one rentable unit, so it can be let straight away."
      />
      <PropertyForm org={org} currencyCode={context.currencyCode} />
    </div>
  );
}
