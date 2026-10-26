import { Card } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { describeOperatorInvitation } from '@propertyos/domain';
import { JoinOperatorForm } from './join-form';

export const metadata = {
  title: 'Join the Spike platform team',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * Becoming a Spike operator.
 *
 * Read privileged, because the person has no session and belongs to nothing.
 * A token that is wrong, withdrawn, expired or already used produces exactly
 * the same page, so the link cannot be used to find out whether an address was
 * invited — the same rule the staff invitation follows, and it matters more
 * here: this is the door to the most privileged surface in the product.
 */
export default async function JoinOperatorPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invitation = await privilegedSql().begin(async (tx) => {
    const described = await describeOperatorInvitation(tx as never, token);
    if (!described) return null;
    const [existing] = await tx<{ id: string }[]>`
      select id from auth.users where email = ${described.invitedEmail}
    `;
    return { ...described, hasAccount: Boolean(existing) };
  });

  if (!invitation) {
    return (
      <main id="main" className="mx-auto max-w-md p-6">
        <Card className="p-6">
          <h1 className="text-lg font-semibold text-ink-900">This invitation is not valid</h1>
          <p className="mt-2 text-sm text-ink-700">
            It may have expired, been withdrawn, or already been used. Ask whoever invited you
            for a new one.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto max-w-md p-6">
      <JoinOperatorForm
        token={token}
        fullName={invitation.fullName}
        email={invitation.invitedEmail}
        roleNames={invitation.roleNames}
        hasAccount={invitation.hasAccount}
      />
    </main>
  );
}
