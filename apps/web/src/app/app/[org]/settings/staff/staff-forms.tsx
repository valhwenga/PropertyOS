'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import {
  changeRolesAction, changeScopeAction, inviteStaffAction, revokeInvitationAction,
  suspendMemberAction,
} from './actions';

/**
 * Colleagues.
 *
 * Two things this screen has to say out loud. An invitation grants nothing
 * until it is accepted, so a pending one is not a member. And no email is
 * sent: the link appears once and has to be passed on, because claiming an
 * invitation was sent when no provider is configured would be a lie the
 * recipient discovers by never receiving it.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface RoleChoice {
  key: string; name: string; description: string; requiresMfa: boolean;
}
export interface PropertyChoice { id: string; label: string }

function Reason({
  name = 'reason', label, placeholder, idPrefix = '',
}: {
  name?: string; label: string; placeholder: string; idPrefix?: string;
}) {
  const id = `${idPrefix}${name}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={id} name={name} required placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
    </div>
  );
}

function RoleChecklist({
  roles, selected, idPrefix,
}: {
  roles: RoleChoice[]; selected: string[]; idPrefix: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink-700">Roles</legend>
      {roles.map((role) => (
        <label
          key={role.key}
          htmlFor={`${idPrefix}role-${role.key}`}
          className="flex gap-2 rounded-lg border border-ink-200 p-3"
        >
          <input
            id={`${idPrefix}role-${role.key}`} type="checkbox" name="roles" value={role.key}
            defaultChecked={selected.includes(role.key)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-ink-900">{role.name}</span>
            <span className="block text-xs text-ink-500">{role.description}</span>
            {role.requiresMfa ? (
              <span className="mt-1 block text-xs text-caution-700">
                Needs an authenticator app. Until they set one up these permissions are
                withheld — they will be able to sign in and see very little.
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ScopeField({
  properties, selectedPropertyId, idPrefix,
}: {
  properties: PropertyChoice[]; selectedPropertyId: string | null; idPrefix: string;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={`${idPrefix}propertyId`}
        className="block text-sm font-medium text-ink-700"
      >
        What they can reach
      </label>
      <select
        id={`${idPrefix}propertyId`} name="propertyId"
        defaultValue={selectedPropertyId ?? ''}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      >
        <option value="">The whole organisation</option>
        {properties.map((p) => (
          <option key={p.id} value={p.id}>Only {p.label}</option>
        ))}
      </select>
      <p className="text-xs text-ink-500">
        A property-scoped colleague sees only that property. Some organisation-wide records,
        the audit trail among them, cannot be narrowed to a property and are not shown to them
        at all.
      </p>
    </div>
  );
}

export function InviteStaffForm({
  org, roles, properties, baseUrl,
}: {
  org: string; roles: RoleChoice[]; properties: PropertyChoice[]; baseUrl: string;
}) {
  const [state, action, pending] = useActionState(inviteStaffAction, null);
  const [open, setOpen] = useState(false);

  const issued = state?.ok
    ? (state as unknown as { token: string; email: string; expiresAt: string })
    : null;

  if (issued) {
    const link = `${baseUrl}/join/${issued.token}`;
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">Invitation ready for {issued.email}</h2>
        <p className="mt-1 text-sm text-ink-700">
          <strong>No email has been sent.</strong> Copy this link and give it to them yourself.
          It is shown once: it is stored only as a hash, so neither you nor Spike can recover
          it afterwards. If it is lost, withdraw the invitation and issue another.
        </p>
        <p className="mt-3 break-all rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs">
          {link}
        </p>
        <p className="mt-2 text-xs text-ink-500">
          Valid until {new Date(issued.expiresAt).toISOString().slice(0, 10)}. It grants
          nothing until they accept it.
        </p>
        <div className="mt-4">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </Card>
    );
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Not invited" />
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          Invite a colleague
        </Button>
      </div>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <h2 className="text-sm font-semibold text-ink-900">Invite a colleague</h2>
        <p className="text-sm text-ink-500">
          An invitation grants nothing until it is accepted. You will get a link to pass on —
          no email is sent from here.
        </p>
        <Problem state={state} title="Not invited" />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="invite-fullName" className="block text-sm font-medium text-ink-700">
              Their name
            </label>
            <input
              id="invite-fullName" name="fullName" required placeholder="Nomsa Dlamini"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="invite-email" className="block text-sm font-medium text-ink-700">
              Their email
            </label>
            <input
              id="invite-email" name="email" type="email" required
              placeholder="nomsa@example.co.za"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <RoleChecklist roles={roles} selected={[]} idPrefix="invite-" />
        <ScopeField properties={properties} selectedPropertyId={null} idPrefix="invite-" />

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Preparing…' : 'Create the invitation'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export function RevokeInvitationForm({
  org, invitationId, email,
}: {
  org: string; invitationId: string; email: string;
}) {
  const [state, action, pending] = useActionState(revokeInvitationAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Not withdrawn" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Withdraw
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="invitationId" value={invitationId} />
      <Problem state={state} title="Not withdrawn" />
      <p className="text-sm text-ink-700">
        The link for {email} stops working immediately. Nothing is taken away, because an
        invitation that was never accepted granted nothing.
      </p>
      <Reason
        label="Why it is being withdrawn" placeholder="Offered to the wrong person."
        idPrefix={`revoke-${invitationId}-`}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Withdraw the invitation'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function MemberForms({
  org, member, roles, properties,
}: {
  org: string; roles: RoleChoice[]; properties: PropertyChoice[];
  member: {
    membershipId: string; name: string; status: string; roles: string[];
    isSelf: boolean; propertyId: string | null;
  };
}) {
  const [roleState, changeRoles, savingRoles] = useActionState(changeRolesAction, null);
  const [scopeState, changeScope, savingScope] = useActionState(changeScopeAction, null);
  const [statusState, changeStatus, savingStatus] = useActionState(suspendMemberAction, null);
  const [mode, setMode] = useState<'none' | 'roles' | 'scope' | 'status'>('none');

  const suspended = member.status === 'suspended';

  if (member.isSelf) {
    return (
      <p className="text-xs text-ink-500">
        This is you. Changing your own roles, scope or access is not possible — that is how one
        compromised account becomes a compromised organisation. Another administrator can do
        it.
      </p>
    );
  }

  if (mode === 'none') {
    return (
      <div className="space-y-2">
        <Problem state={roleState} title="Roles not changed" />
        <Problem state={scopeState} title="Scope not changed" />
        <Problem state={statusState} title="Access not changed" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => setMode('roles')}>
            Change roles
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('scope')}>
            Change what they reach
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('status')}>
            {suspended ? 'Restore access' : 'Suspend access'}
          </Button>
        </div>
      </div>
    );
  }

  if (mode === 'roles') {
    return (
      <form action={changeRoles} className="space-y-3 rounded-lg border border-ink-200 p-3">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="membershipId" value={member.membershipId} />
        <Problem state={roleState} title="Roles not changed" />
        <RoleChecklist
          roles={roles} selected={member.roles} idPrefix={`roles-${member.membershipId}-`}
        />
        <Reason
          label="Why they are changing" placeholder="Moving to the finance team."
          idPrefix={`roles-${member.membershipId}-`}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={savingRoles}>
            {savingRoles ? 'Saving…' : 'Save the roles'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
        </div>
      </form>
    );
  }

  if (mode === 'scope') {
    return (
      <form action={changeScope} className="space-y-3 rounded-lg border border-ink-200 p-3">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="membershipId" value={member.membershipId} />
        <Problem state={scopeState} title="Scope not changed" />
        <ScopeField
          properties={properties} selectedPropertyId={member.propertyId}
          idPrefix={`scope-${member.membershipId}-`}
        />
        <Reason
          label="Why it is changing" placeholder="Taking over the Melville block."
          idPrefix={`scope-${member.membershipId}-`}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={savingScope}>
            {savingScope ? 'Saving…' : 'Save the scope'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
        </div>
      </form>
    );
  }

  return (
    <form action={changeStatus} className="space-y-3 rounded-lg border border-ink-200 p-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <input type="hidden" name="intent" value={suspended ? 'reinstate' : 'suspend'} />
      <Problem state={statusState} title="Access not changed" />
      <p className="text-sm text-ink-700">
        {suspended
          ? `Restoring access lets ${member.name} sign in again, with the roles they already had.`
          : `Suspending stops ${member.name} signing in. It is not a deletion: their roles stay, `
            + 'and everything they did stays recorded against their name — an audit trail whose '
            + 'actors could be deleted would be worth very little.'}
      </p>
      <Reason
        label={suspended ? 'Why access is being restored' : 'Why access is being suspended'}
        placeholder={suspended ? 'Back from leave.' : 'Left the company at the end of the month.'}
        idPrefix={`status-${member.membershipId}-`}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={savingStatus}>
          {savingStatus ? 'Saving…' : suspended ? 'Restore access' : 'Suspend access'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
      </div>
    </form>
  );
}

/** A member's state, in words rather than a badge alone. */
export function MemberStatus({
  status, requiresMfa, hasMfa,
}: {
  status: string; requiresMfa: boolean; hasMfa: boolean;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge
        tone={status === 'active' ? 'positive' : status === 'suspended' ? 'critical' : 'neutral'}
      >
        {status}
      </StatusBadge>
      {requiresMfa && !hasMfa ? (
        <StatusBadge tone="caution" glyph="▲">
          permissions withheld until they add an authenticator
        </StatusBadge>
      ) : null}
    </span>
  );
}
