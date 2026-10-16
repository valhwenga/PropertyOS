import { createHash } from 'node:crypto';
import { Card } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { PortalJoinForm } from './join-form';

export const metadata = { title: 'Open your tenancy' };
export const dynamic = 'force-dynamic';

/**
 * A resident accepting their portal invitation.
 *
 * Deliberately NOT under /portal. That route group's layout calls
 * `requireViewer`, so a resident who does not have an account yet — which is
 * every resident opening this link for the first time — would be bounced to a
 * sign-in page for an account they cannot have.
 *
 * Read on the privileged connection, because the resident has no session and
 * no membership for row-level security to scope them by. The read is narrow:
 * one portal link, found by the hash of the token in the link, and only while
 * it is still open.
 *
 * A token that is wrong, withdrawn, expired or already used produces the same
 * page, so the link cannot be used to find out whether an address was invited.
 */
export default async function PortalJoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const tokenHash = createHash('sha256').update(token).digest();

  const invitation = await privilegedSql().begin(async (tx) => {
    const [row] = await tx<
      { organisation_name: string; resident_name: string; invited_email: string;
        unit_label: string }[]
    >`
      select o.name as organisation_name,
             trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, ''))
               as resident_name,
             pl.invited_email::text as invited_email,
             p.name || ' / ' || u.code as unit_label
        from portal_links pl
        join organisations o on o.id = pl.organisation_id
        join resident_profiles rp on rp.id = pl.resident_id
        join leases l on l.id = pl.lease_id
        join properties p on p.id = l.property_id
        join units u on u.id = l.unit_id
       where pl.invite_token_hash = ${tokenHash}
         and pl.status = 'invited'
         and pl.expires_at > now()
    `;
    if (!row) return null;
    const [existing] = await tx<{ id: string }[]>`
      select id from auth.users where email = ${row.invited_email}
    `;
    return { ...row, hasAccount: Boolean(existing) };
  });

  if (!invitation) {
    return (
      <main className="mx-auto max-w-md p-6">
        <Card className="p-6">
          <h1 className="text-lg font-semibold text-ink-900">This invitation is not valid</h1>
          <p className="mt-2 text-sm text-ink-700">
            It may have expired or already been used. Ask your landlord or agent for a new
            one.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <PortalJoinForm
        token={token}
        organisationName={invitation.organisation_name}
        residentName={invitation.resident_name}
        email={invitation.invited_email}
        unitLabel={invitation.unit_label}
        hasAccount={invitation.hasAccount}
      />
    </main>
  );
}
