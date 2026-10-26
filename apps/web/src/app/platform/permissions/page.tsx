import { Card, DataTable, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { permissionCatalogue } from '@propertyos/domain';
import { readPrivilegedAs, requireViewer } from '@/lib/auth';

export const metadata = { title: 'Roles and permissions' };
export const dynamic = 'force-dynamic';

/**
 * What every role can do.
 *
 * This is reference data that had no screen: support could not answer "why
 * can't our portfolio manager approve that?" without reading SQL. It is
 * readable by anybody in the console, because answering that question is the
 * most ordinary thing support does.
 *
 * Nothing on this page changes anything. What a role can do is the same for
 * every customer and is set by a migration, deliberately: a product's
 * permission model is a product decision. The one lever that exists — an extra
 * permission for one customer's role — lives on that customer's own page,
 * where the operator is already looking at them and can see what else they
 * have.
 */
export default async function PermissionsPage() {
  const viewer = await requireViewer();
  const { roles, permissions } = await readPrivilegedAs(viewer, (tx) =>
    permissionCatalogue(tx, viewer.authUserId),
  );

  const describe = new Map(permissions.map((p) => [p.key, p.description]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles and permissions"
        description="What each role can do, the same for every customer. Changing this for everybody is a migration; giving one customer something extra is done on their own page."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">How to read this</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-700">
          <li>
            A role marked <strong>second factor</strong> withholds every one of its
            permissions until the member has verified an authenticator — they sign in and see
            very little until they do.
          </li>
          <li>
            A role that is <strong>not assignable</strong> cannot be given to a colleague by a
            customer&apos;s administrator. <code>spike_operator</code> is one: it carries
            Spike&apos;s own permission and no customer can hand it out.
          </li>
          <li>
            <strong>Extra</strong> counts the customers who have been given a permission on a
            role that does not normally carry it.
          </li>
        </ul>
      </Card>

      <section aria-labelledby="roles-heading" className="space-y-3">
        <h2 id="roles-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Roles
        </h2>
        {roles.map((role) => (
          <Card key={role.key} className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink-900">{role.name}</p>
                <p className="tabular text-xs text-ink-400">{role.key}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {role.requiresMfa ? (
                  <StatusBadge tone="info" glyph="◆">second factor</StatusBadge>
                ) : null}
                {role.assignableToStaff ? null : (
                  <StatusBadge tone="neutral" glyph="■">not assignable</StatusBadge>
                )}
                {role.overrides > 0 ? (
                  <StatusBadge tone="caution" glyph="＋">
                    extra at {role.overrides} customer{role.overrides === 1 ? '' : 's'}
                  </StatusBadge>
                ) : null}
              </div>
            </div>
            <p className="mt-0.5 text-sm text-ink-700">{role.description}</p>
            {role.permissions.length === 0 ? (
              <p className="mt-2 text-sm text-ink-500">
                Carries nothing. A member holding only this role can see nothing.
              </p>
            ) : (
              <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {role.permissions.map((permission) => (
                  <div key={permission} className="flex flex-wrap items-baseline gap-2">
                    <dt className="tabular text-xs text-ink-600">{permission}</dt>
                    <dd className="text-xs text-ink-400">{describe.get(permission) ?? ''}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        ))}
      </section>

      <section aria-labelledby="permissions-heading" className="space-y-3">
        <h2
          id="permissions-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-500"
        >
          Permissions, and who carries them
        </h2>
        <DataTable
          caption="Every permission in the product and the roles that carry it"
          head={
            <tr>
              <Th>Permission</Th><Th>What it allows</Th><Th>Roles</Th>
              <Th>Support may use it</Th><Th numeric>Extra</Th>
            </tr>
          }
        >
          {permissions.map((permission) => (
            <tr key={permission.key}>
              <Td className="tabular whitespace-nowrap text-xs">{permission.key}</Td>
              <Td className="text-ink-700">{permission.description}</Td>
              <Td className="text-xs text-ink-600">
                {permission.roles.length === 0 ? (
                  <span className="text-ink-400">no role carries it</span>
                ) : permission.roles.join(', ')}
              </Td>
              <Td>
                {permission.grantableToSupport ? (
                  <span className="text-xs text-ink-600">
                    yes, if the customer allows the scope
                  </span>
                ) : (
                  <span className="text-xs text-ink-400">never</span>
                )}
              </Td>
              <Td numeric className="tabular">
                {permission.overrides === 0 ? '' : permission.overrides}
              </Td>
            </tr>
          ))}
        </DataTable>
      </section>
    </div>
  );
}
