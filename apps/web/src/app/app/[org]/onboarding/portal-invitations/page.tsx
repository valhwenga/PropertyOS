import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import { listPortalInvitationCandidates } from '@propertyos/domain';
import { BackLink } from '@/components/back-link';
import { readAs, requireOperator } from '@/lib/auth';
import { BulkInviteForm } from './invite-form';

export const metadata = { title: 'Invite residents to the portal' };
export const dynamic = 'force-dynamic';

/**
 * The last step of bringing a portfolio across.
 *
 * The import brings in properties, units, residents and leases in one sitting,
 * and then every resident had to be invited from their own lease screen — fifty
 * leases is fifty screens, which is how a landlord decides the portal is not
 * worth the trouble. The guard that makes bulk safe is on every row: the name
 * the operator reads beside each checkbox is what the server compares with the
 * resident on that lease before it issues anything.
 */
export default async function PortalInvitationsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);
  const candidates = await readAs(context.viewer, (tx) =>
    listPortalInvitationCandidates(tx, context.organisationId),
  );

  const invitable = candidates.filter((c) => !c.blockedReason).length;

  return (
    <div className="space-y-5">
      <BackLink href={`/app/${org}/onboarding`} label="Import your portfolio" />

      <PageHeader
        title="Invite residents to the portal"
        description="Everybody on an active lease who does not have access yet."
        meta={
          <>
            <span>{invitable} can be invited</span>
            {candidates.length - invitable > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{candidates.length - invitable} need an email address first</span>
              </>
            ) : null}
          </>
        }
      />

      <Card className="p-4 text-sm text-ink-700">
        <p>
          <strong>No email is sent, and none is claimed.</strong> Each invitation produces a
          link you give to that person yourself — by whatever you already use to talk to them.
          Every link is shown once, because only a hash of it is stored.
        </p>
        <p className="mt-2">
          A resident who already has access is not listed, and nobody is invited twice by
          accident.
        </p>
      </Card>

      {candidates.length === 0 ? (
        <EmptyState
          title="Everybody on an active lease already has access"
          description="New residents appear here as leases are activated."
        />
      ) : (
        <BulkInviteForm
          org={org}
          baseUrl={process.env.APP_BASE_URL ?? ''}
          candidates={candidates.map((c) => ({
            key: `${c.leaseId}:${c.residentId}`,
            leaseReference: c.leaseReference,
            unitLabel: c.unitLabel,
            residentName: c.residentName,
            email: c.email,
            blockedReason: c.blockedReason,
          }))}
        />
      )}
    </div>
  );
}
