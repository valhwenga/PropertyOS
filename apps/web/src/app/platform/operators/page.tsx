import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { listOperators, listPlatformRoles, platformPermissionsOf } from '@propertyos/domain';
import { readPrivilegedAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { InviteOperatorForm, OperatorRow } from './operator-forms';

export const metadata = { title: 'Operators' };
export const dynamic = 'force-dynamic';

/**
 * Spike's own staff, and what each of them may do.
 *
 * Read privileged for the usual platform reason — an operator is a member of
 * nothing — with the operator's identity intact, so every function here still
 * resolves its own permission in SQL.
 *
 * The page is readable by anybody in the console and acts only for an
 * administrator. That is deliberate: an operator who cannot see who holds what
 * cannot tell whether a refusal they just hit is their own role or a fault.
 */
export default async function OperatorsPage() {
  const viewer = await requireViewer();
  const { operators, invitations, roles, mine } = await readPrivilegedAs(viewer, async (tx) => {
    const listed = await listOperators(tx, viewer.authUserId);
    return {
      ...listed,
      roles: await listPlatformRoles(tx, viewer.authUserId),
      mine: await platformPermissionsOf(tx, viewer.authUserId),
    };
  });

  const canManage = mine.includes('platform.operators.manage');
  const roleChoices = roles.map((r) => ({ key: r.key, name: r.name, isAdmin: r.isAdmin }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operators"
        description="Who may enter this console, and what each of them may do once inside. Being an operator grants no access to any customer's records."
      />

      {canManage ? null : (
        <Card className="border-info-700/25 bg-info-50 p-4">
          <p className="text-sm text-info-700">
            Your role does not include administering operators, so this page is read-only for
            you. It is shown rather than hidden so you can see what your own role allows.
          </p>
        </Card>
      )}

      <section aria-labelledby="people-heading" className="space-y-3">
        <h2 id="people-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Spike staff ({operators.length})
        </h2>
        {operators.map((operator) => (
          <OperatorRow
            key={operator.authUserId}
            operator={operator}
            roles={roleChoices}
            canManage={canManage}
          />
        ))}
      </section>

      {invitations.length > 0 ? (
        <section aria-labelledby="invited-heading" className="space-y-3">
          <h2
            id="invited-heading"
            className="text-sm font-semibold uppercase tracking-wide text-ink-500"
          >
            Invited, not yet accepted
          </h2>
          <Card className="divide-y divide-ink-100">
            {invitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex flex-wrap items-baseline justify-between gap-3 p-4"
              >
                <div>
                  <p className="text-sm font-medium text-ink-900">{invitation.fullName}</p>
                  <p className="text-xs text-ink-500">
                    {invitation.invitedEmail} ·{' '}
                    {invitation.roles.map((r) =>
                      roles.find((role) => role.key === r)?.name ?? r).join(', ')}{' '}
                    · invited {formatDate(invitation.invitedAt, 'Africa/Johannesburg')}
                  </p>
                </div>
                <StatusBadge tone={invitation.lapsed ? 'critical' : 'caution'} glyph="◐">
                  {invitation.lapsed ? 'the link has expired' : 'waiting to be accepted'}
                </StatusBadge>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {canManage ? (
        <section aria-labelledby="invite-heading" className="space-y-3">
          <h2
            id="invite-heading"
            className="text-sm font-semibold uppercase tracking-wide text-ink-500"
          >
            Bring a colleague in
          </h2>
          <InviteOperatorForm roles={roleChoices} baseUrl={process.env.APP_BASE_URL ?? ''} />
        </section>
      ) : null}

      <section aria-labelledby="roles-heading" className="space-y-3">
        <h2 id="roles-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          What each role carries
        </h2>
        <Card className="divide-y divide-ink-100">
          {roles.map((role) => (
            <div key={role.key} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink-900">{role.name}</p>
                <p className="tabular text-xs text-ink-400">{role.key}</p>
              </div>
              <p className="mt-0.5 text-sm text-ink-700">{role.description}</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {role.permissions.map((permission) => (
                  <li
                    key={permission}
                    className="tabular rounded-md bg-ink-100 px-2 py-0.5 text-xs text-ink-600"
                  >
                    {permission}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
