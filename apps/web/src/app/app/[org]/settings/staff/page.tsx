import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Card, EmptyState, PageHeader, StatusBadge } from '@propertyos/ui';
import {
  assignableRoles, hasPermission, listStaff, listStaffInvitations,
  organisationPermissionOverrides, type RolePermissionOverride,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadPropertyChoices } from '@/lib/operations-queries';
import {
  InviteStaffForm, MemberForms, MemberStatus, RevokeInvitationForm,
} from './staff-forms';

export const metadata = { title: 'Colleagues' };
export const dynamic = 'force-dynamic';

/**
 * Colleagues.
 *
 * Roles and the per-role second-factor requirement have existed since the
 * eighth migration and there was no way to add anybody: an organisation was
 * created with one member and stayed that way. Which means the separation of
 * duties the rest of the product insists on — a preparer who is not the
 * approver, a requester who is not the person who approves the payout — could
 * not be set up by the customer at all.
 */
export default async function StaffPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    const canManage = await hasPermission(tx, context.organisationId, 'membership.manage');
    // Read for everybody who can open this page, including somebody without
    // the membership permission: Spike widening what your colleagues may do is
    // something you are entitled to see whether or not you administer them.
    const granted = await organisationPermissionOverrides(tx, context.organisationId);
    if (!canManage) {
      return {
        canManage, granted, members: [], invitations: [], roles: [], properties: [],
      };
    }
    return {
      canManage,
      granted,
      members: await listStaff(tx, context.organisationId, context.viewer.authUserId),
      invitations: await listStaffInvitations(tx, context.organisationId),
      roles: await assignableRoles(tx),
      properties: await loadPropertyChoices(tx, context.organisationId),
    };
  });
  const { canManage, granted, members, invitations, roles, properties } = data;

  const baseUrl = process.env.APP_BASE_URL ?? '';
  const propertyChoices = properties.map((p) => ({ id: p.id, label: `${p.name} (${p.code})` }));
  const mfaRoles = new Set(roles.filter((r) => r.requiresMfa).map((r) => r.key));
  const open = invitations.filter((i) => i.status === 'invited');
  const closed = invitations.filter((i) => i.status !== 'invited');

  if (!canManage) {
    return (
      <div className="space-y-6">
        <BackLink href={`/app/${org}/settings`} label="Settings" />
        <PageHeader title="Colleagues" description="Who can use this organisation, and what they can do." />
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            Inviting colleagues and changing what they can do needs the membership permission,
            which the organisation administrator holds.
          </p>
          {context.viewer.assuranceLevel !== 'aal2' ? (
            <p className="mt-2 text-sm text-ink-700">
              If you are the administrator, this is why: the role requires a second factor and
              this session has only a password. The permission is withheld until you add an
              authenticator and sign in with it — which is also the state a newly set-up
              organisation starts in.{' '}
              <Link href="/account/security" className="text-spike-600 hover:underline">
                Set up an authenticator →
              </Link>
            </p>
          ) : null}
        </Card>

      {granted.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            Spike has given {granted.length === 1 ? 'one of your roles' : 'some of your roles'}{' '}
            an extra permission
          </p>
          <p className="mt-1 text-sm text-ink-700">
            At your request, on this account only. Each one needs the colleague to have an
            authenticator set up, even where the role itself does not. Ask Spike support to
            remove any of these and they go.
          </p>
          <ul className="mt-2 space-y-1.5">
            {granted.map((extra: RolePermissionOverride) => (
              <li key={`${extra.roleKey}:${extra.permissionKey}`} className="text-sm text-ink-700">
                <strong>{extra.roleName}</strong> can also {extra.permissionDescription.toLowerCase()}
                <span className="block text-xs text-ink-500">
                  {extra.reason}
                  {extra.grantedByName ? ` · granted by ${extra.grantedByName} at Spike` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackLink href={`/app/${org}/settings`} label="Settings" />

      <PageHeader
        title="Colleagues"
        description="Who can use this organisation, what they can do, and which properties they can reach."
      />


      {granted.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            Spike has given {granted.length === 1 ? 'one of your roles' : 'some of your roles'}{' '}
            an extra permission
          </p>
          <p className="mt-1 text-sm text-ink-700">
            At your request, on this account only. Each one needs the colleague to have an
            authenticator set up, even where the role itself does not. Ask Spike support to
            remove any of these and they go.
          </p>
          <ul className="mt-2 space-y-1.5">
            {granted.map((extra: RolePermissionOverride) => (
              <li key={`${extra.roleKey}:${extra.permissionKey}`} className="text-sm text-ink-700">
                <strong>{extra.roleName}</strong> can also {extra.permissionDescription.toLowerCase()}
                <span className="block text-xs text-ink-500">
                  {extra.reason}
                  {extra.grantedByName ? ` · granted by ${extra.grantedByName} at Spike` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <InviteStaffForm
        org={org} roles={roles} properties={propertyChoices} baseUrl={baseUrl}
      />

      {/* ------------------------------------------------------------ members */}

      <section aria-labelledby="members" className="space-y-3">
        <h2 id="members" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Members
        </h2>
        <Card>
          <ul>
            {members.map((member) => (
              <li key={member.membershipId} className="border-t border-ink-100 p-4 first:border-t-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-medium text-ink-900">
                      {member.fullName ?? member.email ?? 'Unnamed'}
                      {member.isSelf ? <span className="text-ink-400"> — you</span> : null}
                    </p>
                    <p className="text-xs text-ink-500">
                      {member.email ?? 'no address on file'}
                      {' · '}
                      {member.roles.length > 0
                        ? member.roles.join(', ')
                        : 'no roles'}
                      {' · '}
                      {member.scope.type === 'organisation'
                        ? 'the whole organisation'
                        : member.scope.type === 'none'
                          ? 'nothing assigned'
                          : `only ${member.scope.label ?? member.scope.type}`}
                    </p>
                  </div>
                  <MemberStatus
                    status={member.status}
                    requiresMfa={member.requiresMfa}
                    hasMfa={member.hasMfa}
                  />
                </div>
                <div className="mt-3">
                  <MemberForms
                    org={org} roles={roles} properties={propertyChoices}
                    member={{
                      membershipId: member.membershipId,
                      name: member.fullName ?? member.email ?? 'this member',
                      status: member.status,
                      roles: member.roles,
                      isSelf: member.isSelf,
                      propertyId: member.scope.propertyId,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {/* -------------------------------------------------------- invitations */}

      <section aria-labelledby="invitations" className="space-y-3">
        <h2
          id="invitations"
          className="text-sm font-semibold uppercase tracking-wide text-ink-500"
        >
          Invitations
        </h2>
        <p className="text-sm text-ink-500">
          An invitation grants nothing until it is accepted. Nobody on this list can sign in
          yet.
        </p>

        {open.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="No invitation is waiting to be accepted."
          />
        ) : (
          <Card>
            <ul>
              {open.map((invitation) => (
                <li key={invitation.id} className="border-t border-ink-100 p-4 first:border-t-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-medium text-ink-900">{invitation.fullName}</p>
                      <p className="text-xs text-ink-500">
                        {invitation.invitedEmail} · {invitation.roles.join(', ')}
                        {invitation.invitedByName ? ` · invited by ${invitation.invitedByName}` : ''}
                        {' · '}
                        {invitation.lapsed
                          ? 'expired'
                          : `valid until ${formatDate(invitation.expiresAt, context.timeZone)}`}
                      </p>
                    </div>
                    {invitation.lapsed ? (
                      <StatusBadge tone="neutral" glyph="○">
                        expired — the link no longer works
                      </StatusBadge>
                    ) : (
                      <StatusBadge tone="caution" glyph="◐">waiting to be accepted</StatusBadge>
                    )}
                  </div>
                  {invitation.roles.some((r) => mfaRoles.has(r)) ? (
                    <p className="mt-2 text-xs text-caution-700">
                      Needs an authenticator app. They will be able to sign in and will see
                      very little until they add one, because these permissions stay withheld
                      until they do.
                    </p>
                  ) : null}
                  <div className="mt-3">
                    <RevokeInvitationForm
                      org={org} invitationId={invitation.id} email={invitation.invitedEmail}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {closed.length > 0 ? (
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-ink-900">Already decided</h3>
            <ul className="mt-2 space-y-2">
              {closed.map((invitation) => (
                <li key={invitation.id} className="text-sm text-ink-700">
                  <span className="font-medium">{invitation.invitedEmail}</span>
                  {' — '}
                  {invitation.status}
                  {invitation.acceptedAt
                    ? ` on ${formatDate(invitation.acceptedAt, context.timeZone)}`
                    : ''}
                  {invitation.revokeReason ? `: ${invitation.revokeReason}` : ''}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
