import { Card } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { describeStaffInvitation } from '@propertyos/domain';
import { JoinForm } from './join-form';

export const metadata = { title: 'Join an organisation' };
export const dynamic = 'force-dynamic';

/**
 * Accepting a staff invitation.
 *
 * Read on a privileged connection, because the person has no session and no
 * membership for row-level security to scope them by. The read is narrow: one
 * invitation, found by the hash of the token in the link, and only while it is
 * still open.
 *
 * A token that is wrong, withdrawn, expired or already used produces the same
 * page, so the link cannot be used to find out whether an address was invited.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invitation = await privilegedSql().begin(async (tx) => {
    const described = await describeStaffInvitation(tx as never, token);
    if (!described) return null;
    const [existing] = await tx<{ id: string }[]>`
      select id from auth.users where email = ${described.invitedEmail}
    `;
    return { ...described, hasAccount: Boolean(existing) };
  });

  if (!invitation) {
    return (
      <main className="mx-auto max-w-md p-6">
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
    <main className="mx-auto max-w-md p-6">
      <JoinForm
        token={token}
        organisationName={invitation.organisationName}
        fullName={invitation.fullName}
        email={invitation.invitedEmail}
        roles={invitation.roles}
        hasAccount={invitation.hasAccount}
      />
    </main>
  );
}
