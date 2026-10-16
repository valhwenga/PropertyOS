import Link from 'next/link';
import { PageHeader } from '@propertyos/ui';
import { requirePlatformOperator } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { ProvisionForm } from './provision-form';

export const metadata = { title: 'New customer' };
export const dynamic = 'force-dynamic';

/**
 * Setting up a new customer.
 *
 * `createOrganisationWithOwner` has existed since the first migration with no
 * screen, so every organisation in existence was created by the seed or by a
 * test — a new customer could not be set up in the product at all.
 */
export default async function NewCustomerPage() {
  const viewer = await requireViewer();

  const plans = await readAs(viewer, async (tx) => {
    // Refused here as well as in the command, so somebody without the right
    // gets a page that says so rather than a form that fails on submit.
    await requirePlatformOperator(tx, viewer.authUserId);
    return tx<{ key: string; name: string; included_units: number }[]>`
      select key, name, included_units from plans where is_active order by included_units
    `;
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/platform" className="text-sm text-spike-600 hover:underline">
        ← Customers
      </Link>

      <PageHeader
        title="Set up a customer"
        description="Creates the organisation and invites its first administrator. Spike is never a member of what it creates."
      />

      <ProvisionForm
        baseUrl={process.env.APP_BASE_URL ?? ''}
        plans={plans.map((plan) => ({
          key: plan.key, name: plan.name, includedUnits: plan.included_units,
        }))}
      />
    </div>
  );
}
