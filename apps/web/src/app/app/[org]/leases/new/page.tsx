import { PageHeader } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { loadLeaseDraftChoices } from '@/lib/operations-queries';
import { LeaseForm } from './lease-form';

export const metadata = { title: 'Draft a lease' };
export const dynamic = 'force-dynamic';

export default async function NewLeasePage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const { units, residents } = await readAs(context.viewer, (tx) =>
    loadLeaseDraftChoices(tx, context.organisationId));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Draft a lease"
        description="A draft has no billing effect and does not reserve the unit. Activating it is a separate step."
      />
      <LeaseForm org={org} currencyCode={context.currencyCode} units={units} residents={residents} />
    </div>
  );
}
