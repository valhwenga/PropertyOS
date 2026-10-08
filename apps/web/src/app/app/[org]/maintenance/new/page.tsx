import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { loadTicketUnitChoices } from '@/lib/operations-queries';
import { LogRequestForm } from './form';

export const metadata = { title: 'Log a maintenance request' };
export const dynamic = 'force-dynamic';

/**
 * An operator logging a request themselves.
 *
 * The Maintenance screen has linked here since it was built, and nothing was
 * here: `/maintenance/new` fell through to the ticket detail route, which tried
 * to read "new" as a ticket id and returned a 500. So the only way a request
 * could reach the system was a resident submitting one through the portal —
 * which is no use for the phone call, the caretaker's note, or anything an
 * operator spots themselves.
 *
 * A request logged here records the operator as the reporter. The resident's own
 * claimed urgency is a separate thing the domain keeps apart, so nothing logged
 * on this screen can overwrite what a resident said.
 */
export default async function NewTicketPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const units = await readAs(context.viewer, (tx) =>
    loadTicketUnitChoices(tx, context.organisationId));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href={`/app/${org}/maintenance`} className="text-sm text-spike-600 hover:underline">
        ← All requests
      </Link>
      <PageHeader
        title="Log a maintenance request"
        description="For something reported to you by phone, noticed on site, or raised by a caretaker. A resident's own request comes in through their portal."
      />

      {units.length === 0 ? (
        <EmptyState
          title="No units in your scope"
          description="A maintenance request is logged against a unit. Add a property with at least one unit, or ask an administrator to widen your property scope."
          action={
            <Link
              href={`/app/${org}/portfolio/new`}
              className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
            >
              Add a property
            </Link>
          }
        />
      ) : (
        <Card className="p-5">
          <LogRequestForm org={org} units={units} />
        </Card>
      )}
    </div>
  );
}
