'use client';

import { useActionState, useState } from 'react';
import { Button, Card } from '@propertyos/ui';
import { grantRolePermissionAction, revokeRolePermissionAction } from './actions';

/**
 * Extra permissions one customer asked for.
 *
 * The screen is built around the one rule that makes this safe to offer at
 * all: it can only ever ADD. There is no control here that takes a permission
 * away from a role, so no sequence of clicks can lock a customer out of their
 * own account, and the only thing "remove" does is undo a grant made here.
 *
 * The permission list offered is the ones the chosen role does not already
 * carry, because granting what it already has everywhere is noise the database
 * refuses anyway.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export interface RoleChoice {
  key: string;
  name: string;
  assignableToStaff: boolean;
  permissions: string[];
}

export interface PermissionChoice { key: string; description: string }

export interface ExistingOverride {
  roleKey: string;
  roleName: string;
  permissionKey: string;
  permissionDescription: string;
  reason: string;
  grantedByName: string | null;
  grantedAt: string;
}

export function PermissionOverrides({
  organisationId, slug, customerName, roles, permissions, overrides, canManage,
}: {
  organisationId: string;
  slug: string;
  customerName: string;
  roles: RoleChoice[];
  permissions: PermissionChoice[];
  overrides: ExistingOverride[];
  canManage: boolean;
}) {
  const [granted, grant, granting] = useActionState(grantRolePermissionAction, null);
  const [revoked, revoke, revoking] = useActionState(revokeRolePermissionAction, null);
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [removing, setRemoving] = useState<string | null>(null);

  const role = roles.find((r) => r.key === roleKey);
  const offerable = permissions.filter(
    (p) => p.key !== 'platform.admin' && !(role?.permissions ?? []).includes(p.key),
  );

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Extra permissions</h2>
      <p className="mt-1 text-sm text-ink-700">
        Something this customer asked for, on one of their roles, for this account only.
        It is added to what the role already does — nothing here can take a permission
        away, so this cannot lock them out.
      </p>
      <p className="mt-1 text-xs text-ink-500">
        An extra permission always requires the member to have verified a second factor,
        even where the role itself does not. {customerName} can see every one of these on
        their own staff screen, with your name and your reason.
      </p>

      {overrides.length > 0 ? (
        <ul className="mt-4 divide-y divide-ink-100 border-t border-ink-100">
          {overrides.map((override) => {
            const id = `${override.roleKey}:${override.permissionKey}`;
            return (
              <li key={id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-sm text-ink-900">
                      <strong>{override.roleName}</strong> also has{' '}
                      <span className="tabular text-xs">{override.permissionKey}</span>
                    </p>
                    <p className="text-xs text-ink-500">
                      {override.permissionDescription} · {override.reason}
                      {override.grantedByName ? ` · granted by ${override.grantedByName}` : ''}
                    </p>
                  </div>
                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => setRemoving(removing === id ? null : id)}
                      className="text-sm font-medium text-ink-600 hover:underline"
                    >
                      {removing === id ? 'Keep it' : 'Remove'}
                    </button>
                  ) : null}
                </div>
                {removing === id ? (
                  <form action={revoke} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="organisationId" value={organisationId} />
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="roleKey" value={override.roleKey} />
                    <input type="hidden" name="permissionKey" value={override.permissionKey} />
                    <div className="min-w-60 flex-1">
                      <label className={LABEL} htmlFor={`why-${id}`}>Why remove it</label>
                      <input
                        id={`why-${id}`} name="reason" required minLength={5} maxLength={500}
                        placeholder="Ticket closed; they changed their mind"
                        className={`mt-1 ${FIELD}`}
                      />
                    </div>
                    <Button type="submit" variant="danger" disabled={revoking}>
                      {revoking ? 'Removing…' : 'Remove it'}
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 border-t border-ink-100 pt-3 text-sm text-ink-500">
          None. Every role here does exactly what it does at every other customer.
        </p>
      )}

      {revoked && !revoked.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{revoked.message}</p>
        </div>
      ) : null}

      {canManage ? (
        <form action={grant} className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="slug" value={slug} />

          {granted && !granted.ok ? (
            <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
              <p className="text-sm text-critical-700">{granted.message}</p>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="roleKey">Which of their roles</label>
              <select
                id="roleKey" name="roleKey" required value={roleKey}
                onChange={(event) => setRoleKey(event.target.value)}
                className={`mt-1 ${FIELD}`}
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}{r.assignableToStaff ? '' : ' — not assignable to staff'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="permissionKey">What to add</label>
              <select id="permissionKey" name="permissionKey" required className={`mt-1 ${FIELD}`}>
                {offerable.map((p) => (
                  <option key={p.key} value={p.key}>{p.key} — {p.description}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-500">
                Only what this role does not already carry everywhere.
              </p>
            </div>
          </div>

          <div>
            <label className={LABEL} htmlFor="grant-reason">Who asked, and why</label>
            <input
              id="grant-reason" name="reason" required minLength={5} maxLength={500}
              placeholder="SPK-7700: their managers buy materials and the owner wants it that way"
              className={`mt-1 ${FIELD}`}
            />
          </div>

          <Button type="submit" variant="primary" disabled={granting}>
            {granting ? 'Granting…' : 'Grant it'}
          </Button>
        </form>
      ) : (
        <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
          Your platform role does not include changing permissions, so this is read-only
          for you.
        </p>
      )}
    </Card>
  );
}
