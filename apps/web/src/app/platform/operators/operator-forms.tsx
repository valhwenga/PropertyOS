'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import {
  inviteOperatorAction, revokeOperatorAction, setOperatorRolesAction,
} from './actions';

/**
 * One operator, with their roles changeable in place.
 *
 * Each row keeps its own action state, so a refusal lands on the person it is
 * about rather than at the top of the page. The row an administrator is
 * looking at themselves offers no revoke: taking your own console access away
 * is the one change that cannot be undone from inside the console, so the
 * domain refuses it and the screen does not offer it either.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export interface RoleChoice { key: string; name: string; isAdmin: boolean }

interface OperatorView {
  authUserId: string;
  fullName: string;
  email: string;
  roles: string[];
  mfaEnrolled: boolean;
  isSelf: boolean;
}

export function OperatorRow({
  operator, roles, canManage,
}: { operator: OperatorView; roles: RoleChoice[]; canManage: boolean }) {
  const [saved, save, saving] = useActionState(setOperatorRolesAction, null);
  const [revoked, revoke, revoking] = useActionState(revokeOperatorAction, null);
  const [confirming, setConfirming] = useState(false);

  if (revoked?.ok) {
    return (
      <Card className="p-4">
        <p className="text-sm text-ink-700">
          {operator.fullName} no longer has console access. Their account and their name on
          everything they did are untouched.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4" aria-label={operator.fullName} data-operator={operator.email}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-900">
            {operator.fullName}
            {operator.isSelf ? <span className="ml-2 text-xs text-ink-400">you</span> : null}
          </p>
          <p className="text-xs text-ink-500">{operator.email}</p>
        </div>
        {operator.mfaEnrolled ? null : (
          <StatusBadge tone="caution" glyph="▲">
            no second factor — the console stays closed to them
          </StatusBadge>
        )}
      </div>

      {saved && !saved.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{saved.message}</p>
        </div>
      ) : null}
      {revoked && !revoked.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{revoked.message}</p>
        </div>
      ) : null}

      {canManage ? (
        <form action={save} className="mt-3 space-y-3">
          <input type="hidden" name="operatorUserId" value={operator.authUserId} />
          <fieldset>
            <legend className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Roles
            </legend>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {roles.map((role) => (
                <label key={role.key} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox" name="roles" value={role.key}
                    defaultChecked={operator.roles.includes(role.key)}
                    className="h-4 w-4 rounded border-ink-300"
                  />
                  {role.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save roles'}
            </Button>
            {saved?.ok ? <span className="text-sm text-ink-500">Saved.</span> : null}
            {operator.isSelf ? null : (
              <button
                type="button"
                onClick={() => setConfirming((open) => !open)}
                className="text-sm font-medium text-ink-600 hover:underline"
              >
                {confirming ? 'Keep their access' : 'Remove console access'}
              </button>
            )}
          </div>
        </form>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {operator.roles.length === 0 ? (
            <li className="text-sm text-ink-500">No roles, so the console shows them nothing.</li>
          ) : operator.roles.map((role) => (
            <li key={role} className="rounded-md bg-ink-100 px-2 py-0.5 text-xs text-ink-600">
              {roles.find((r) => r.key === role)?.name ?? role}
            </li>
          ))}
        </ul>
      )}

      {confirming && canManage && !operator.isSelf ? (
        <form action={revoke} className="mt-3 border-t border-ink-100 pt-3">
          <input type="hidden" name="operatorUserId" value={operator.authUserId} />
          <p className="text-sm text-ink-700">
            This takes away {operator.fullName}'s access to the console and their platform
            roles. Their account stays, so their name remains on everything they did.
          </p>
          <Button type="submit" variant="danger" className="mt-2" disabled={revoking}>
            {revoking ? 'Removing…' : `Remove ${operator.fullName}`}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export function InviteOperatorForm({
  roles, baseUrl,
}: { roles: RoleChoice[]; baseUrl: string }) {
  const [state, action, pending] = useActionState(inviteOperatorAction, null);

  const invited = state?.ok
    ? (state as unknown as { token: string; email: string; expiresAt: string })
    : null;

  if (invited) {
    return (
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-ink-900">Invitation ready</h3>
        <p className="mt-1 text-sm text-ink-700">
          <strong>No email has been sent.</strong> Give this link to {invited.email} yourself.
          It is shown once: only a hash is stored, so nobody can recover it afterwards.
        </p>
        <p className="mt-3 break-all rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs">
          {baseUrl}/join-operator/{invited.token}
        </p>
        <p className="mt-2 text-xs text-ink-500">
          Valid until {invited.expiresAt.slice(0, 10)}. They will be asked to enrol an
          authenticator before the console opens to them.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        {state && !state.ok ? (
          <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
            <p className="text-sm text-critical-700">{state.message}</p>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="fullName">Their full name</label>
            <input id="fullName" name="fullName" required maxLength={160} className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label className={LABEL} htmlFor="email">Their email address</label>
            <input
              id="email" name="email" type="email" required maxLength={254}
              className={`mt-1 ${FIELD}`}
            />
          </div>
        </div>

        <fieldset>
          <legend className={LABEL}>What they may do</legend>
          <div className="mt-1.5 space-y-1.5">
            {roles.map((role) => (
              <label key={role.key} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox" name="roles" value={role.key}
                  defaultChecked={role.key === 'platform_support'}
                  className="h-4 w-4 rounded border-ink-300"
                />
                {role.name}
                {role.isAdmin ? (
                  <span className="text-xs text-caution-700">
                    — can administer operators, including you
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creating the invitation…' : 'Invite them'}
        </Button>
      </form>
    </Card>
  );
}
