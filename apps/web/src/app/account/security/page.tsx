import { BackLink } from '@/components/back-link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { mfaStatus } from '@/lib/mfa';
import { requireViewer } from '@/lib/auth';
import { EnrolForm, ManageFactorForm } from './security-forms';

export const metadata = { title: 'Your sign-in security' };
export const dynamic = 'force-dynamic';

/**
 * Your own second factor.
 *
 * The assurance machinery has existed since 0015 and there was no way for a
 * person to enrol: the only path was a developer command run against the
 * database. So a colleague invited as a finance approver could sign in,
 * correctly see almost nothing, and have no way out of that state.
 *
 * Read on the privileged connection because the factor tables hold TOTP
 * secrets and are deliberately unreadable by the application role — and only
 * ever about the signed-in person, whose id comes from the session rather than
 * from the request.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ recovered?: string }>;
}) {
  const { recovered } = await searchParams;
  const viewer = await requireViewer();
  const status = await mfaStatus(privilegedSql(), viewer.authUserId);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <BackLink href="/account" label="Your profile" />

      <PageHeader
        title="Sign-in security"
        description="The second factor on your own account. Nobody else can change it — not another administrator, and not Spike."
      />

      {recovered ? (
        <Card className="border-caution-700/30 bg-caution-50 p-4">
          <p className="text-sm text-caution-700">
            You signed in with a recovery code, so that code is now spent. If your phone is
            gone, remove the old authenticator below and set up the new one.
          </p>
        </Card>
      ) : null}

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-ink-900">This session</p>
          <p className="text-sm text-ink-500">
            {viewer.assuranceLevel === 'aal2'
              ? 'Signed in with a second factor, so elevated permissions are available.'
              : 'Signed in with a password only. Elevated permissions stay withheld on this '
                + 'session until you sign in with a code.'}
          </p>
        </div>
        <StatusBadge tone={viewer.assuranceLevel === 'aal2' ? 'positive' : 'caution'}>
          {viewer.assuranceLevel === 'aal2' ? 'two factors' : 'password only'}
        </StatusBadge>
      </Card>

      {status.enrolled ? (
        <ManageFactorForm
          unusedRecoveryCodes={status.unusedRecoveryCodes}
          enrolledAt={status.enrolledAt}
        />
      ) : (
        <>
          {status.pending ? (
            <Card className="p-4">
              <p className="text-sm text-ink-700">
                You started setting up an authenticator and did not finish. Nothing was
                switched on — start again below and the earlier key is replaced.
              </p>
            </Card>
          ) : null}
          <EnrolForm email={viewer.email} />
        </>
      )}
    </div>
  );
}
