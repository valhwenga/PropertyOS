import { EmptyState, PageHeader } from '@propertyos/ui';
import { listPlans, listSignupRequests } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { RequestDecision } from './decision-forms';

export const metadata = { title: 'Requests for an account' };
export const dynamic = 'force-dynamic';

/**
 * The queue behind the public form.
 *
 * Approving one is provisioning: the same function, the same invitation, the
 * same audit entry. Nothing here creates an organisation on its own, because
 * nothing in this build can prove an email address belongs to whoever typed
 * it or take a payment for the account — so a person reads the row.
 *
 * Every request is rendered by the same component whatever its status, in one
 * list, keyed by id. That is not tidiness: approving one re-renders this page
 * with the request no longer open, and a component that moved between two
 * branches of the markup would be UNMOUNTED by that re-render — taking with
 * it the invitation link, which is shown once and cannot be recovered. Keeping
 * its position stable is what lets the operator still read it.
 */
export default async function SignupRequestsPage() {
  const viewer = await requireViewer();
  const [requests, plans] = await readAs(viewer, async (tx) => [
    await listSignupRequests(tx, viewer.authUserId),
    await listPlans(tx),
  ] as const);

  const open = requests.filter((r) => r.status === 'requested');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Requests for an account"
        description="Landlords who asked through the public form. Approving one sets the organisation up exactly as the provisioning screen does."
      />

      {requests.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="Requests sent through /request-access appear here."
        />
      ) : (
        <section aria-labelledby="queue-heading" className="space-y-3">
          <h2 id="queue-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            {open.length === 0
              ? 'Nothing waiting on a decision'
              : `Waiting on a decision (${open.length})`}
          </h2>
          {requests.map((request) => (
            <RequestDecision
              key={request.id}
              request={{
                id: request.id,
                organisationName: request.organisationName,
                contactName: request.contactName,
                contactEmail: request.contactEmail,
                contactPhone: request.contactPhone,
                portfolioSize: request.portfolioSize,
                note: request.note,
                status: request.status,
                declineReason: request.declineReason,
                createdAt: formatDate(request.createdAt, 'Africa/Johannesburg'),
                suggestedSlug: request.suggestedSlug,
              }}
              plans={plans.map((p) => ({
                key: p.key, name: p.name, includedUnits: p.includedUnits,
              }))}
              baseUrl={process.env.APP_BASE_URL ?? ''}
            />
          ))}
        </section>
      )}
    </div>
  );
}
