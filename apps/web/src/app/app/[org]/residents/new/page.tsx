import { PageHeader } from '@propertyos/ui';
import { requireOperator } from '@/lib/auth';
import { ResidentForm } from './resident-form';

export const metadata = { title: 'Add a resident' };
export const dynamic = 'force-dynamic';

export default async function NewResidentPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  await requireOperator(org);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Add a resident"
        description="A person record. They can exist with no portal account, and the same person can later appear on more than one lease."
      />
      <ResidentForm org={org} />
    </div>
  );
}
