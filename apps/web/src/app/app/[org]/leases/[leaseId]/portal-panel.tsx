'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import { issuePortalInvitationAction, revokePortalAccessAction } from './portal-actions';

/**
 * Who on this lease can see their own statement.
 *
 * The invitation commands have existed since §8 with no screen, so this is the
 * first time an operator can invite a resident at all — or take the access
 * away again.
 *
 * The panel is built around the one mistake that matters: linking an address
 * to the wrong resident. The name is restated at the moment of sending and
 * sent back to the server with the request, so a review of one resident cannot
 * be submitted for another.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface PortalParty {
  residentId: string;
  name: string;
  email: string | null;
  role: string;
  canViewFinancials: boolean;
  portalLinkId: string | null;
  status: string | null;
  invitedEmail: string | null;
  expiresAt: string | null;
  lapsed: boolean;
}

const STATE: Record<string, { tone: 'positive' | 'caution' | 'critical' | 'neutral'; label: string }> = {
  active: { tone: 'positive', label: 'has access' },
  invited: { tone: 'caution', label: 'invited, not yet accepted' },
  revoked: { tone: 'critical', label: 'access revoked' },
  expired: { tone: 'neutral', label: 'invitation expired' },
};

function InviteForm({
  org, leaseId, party, baseUrl,
}: {
  org: string; leaseId: string; party: PortalParty; baseUrl: string;
}) {
  const [state, action, pending] = useActionState(issuePortalInvitationAction, null);
  const [open, setOpen] = useState(false);

  const issued = state?.ok
    ? (state as unknown as {
        token: string; email: string; expiresAt: string; residentName: string;
      })
    : null;

  if (issued) {
    return (
      <Card className="border-caution-700/30 bg-caution-50 p-4">
        <p className="text-sm font-semibold text-caution-700">
          Invitation ready for {issued.residentName}
        </p>
        <p className="mt-1 text-sm text-ink-700">
          <strong>No email has been sent.</strong> Give this link to {issued.email} yourself.
          It is shown once — only a hash of it is stored, so it cannot be shown again and
          nobody can recover it later.
        </p>
        <p className="mt-3 break-all rounded-lg border border-ink-200 bg-surface p-3 font-mono text-xs">
          {baseUrl}/tenancy/{issued.token}
        </p>
        <p className="mt-2 text-xs text-ink-500">
          Valid until {issued.expiresAt.slice(0, 10)}. Until they accept it they have no
          access to anything. Reload this page once you have the link to see the list update.
        </p>
      </Card>
    );
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Not invited" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {party.status === 'revoked' || party.status === 'expired'
            ? 'Invite again' : 'Invite to the portal'}
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="residentId" value={party.residentId} />
      <input type="hidden" name="confirmedRecipient" value={party.name} />
      <Problem state={state} title="Not invited" />

      <p className="text-sm text-ink-700">
        You are inviting <strong>{party.name}</strong>, the {party.role.replace(/_/g, ' ')} on
        this lease. Check that is the person you mean: an address linked to the wrong resident
        shows them somebody else&rsquo;s statement.
      </p>
      <p className="text-sm text-ink-500">
        {party.canViewFinancials
          ? 'They can see the money on this lease — charges, receipts and the balance.'
          : 'They are not marked as able to see financials, so they will see the lease and '
            + 'maintenance but not the money.'}
      </p>

      <div className="space-y-1.5">
        <label
          htmlFor={`email-${party.residentId}`}
          className="block text-sm font-medium text-ink-700"
        >
          Their email address
        </label>
        <input
          id={`email-${party.residentId}`} name="email" type="email" required
          defaultValue={party.email ?? ''}
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
        <p className="text-xs text-ink-500">
          This becomes the address they sign in with. No email is sent from here — you will
          get a link to pass on.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Preparing…' : 'Create the invitation'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

function RevokeForm({
  org, leaseId, party,
}: {
  org: string; leaseId: string; party: PortalParty;
}) {
  const [state, action, pending] = useActionState(revokePortalAccessAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Not revoked" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {party.status === 'invited' ? 'Withdraw the invitation' : 'Take access away'}
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-3">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="portalLinkId" value={party.portalLinkId ?? ''} />
      <Problem state={state} title="Not revoked" />
      <p className="text-sm text-ink-700">
        {party.status === 'invited'
          ? `The link stops working immediately. ${party.name} never had access, so nothing `
            + 'is taken away.'
          : `${party.name} will not be able to sign in. Nothing about their lease, their `
            + 'charges or their payments changes — this is about the portal, not the tenancy.'}
      </p>
      <div className="space-y-1.5">
        <label
          htmlFor={`reason-${party.residentId}`}
          className="block text-sm font-medium text-ink-700"
        >
          Why
        </label>
        <input
          id={`reason-${party.residentId}`} name="reason" required
          placeholder="Moved out at the end of the lease."
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Confirm'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function PortalAccessPanel({
  org, leaseId, parties, baseUrl, canManage,
}: {
  org: string; leaseId: string; parties: PortalParty[]; baseUrl: string; canManage: boolean;
}) {
  return (
    <section aria-labelledby="portal-access" className="space-y-3">
      <h2
        id="portal-access"
        className="text-sm font-semibold uppercase tracking-wide text-ink-500"
      >
        Resident portal access
      </h2>

      {parties.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            Nobody is a party to this lease yet, so there is nobody to invite.
          </p>
        </Card>
      ) : (
        <Card>
          <ul>
            {parties.map((party) => (
              <li key={party.residentId} className="border-t border-ink-100 p-4 first:border-t-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-medium text-ink-900">{party.name}</p>
                    <p className="text-xs text-ink-500">
                      {party.role.replace(/_/g, ' ')}
                      {party.invitedEmail ? ` · ${party.invitedEmail}` : party.email ? ` · ${party.email}` : ''}
                      {party.canViewFinancials ? ' · can see the money' : ' · cannot see the money'}
                    </p>
                  </div>
                  {party.status ? (
                    <StatusBadge
                      tone={party.lapsed ? 'neutral' : STATE[party.status]!.tone}
                    >
                      {party.lapsed ? 'invitation expired' : STATE[party.status]!.label}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">no portal access</StatusBadge>
                  )}
                </div>

                {canManage ? (
                  <div className="mt-3 space-y-2">
                    {party.status === 'active' || (party.status === 'invited' && !party.lapsed) ? (
                      <RevokeForm org={org} leaseId={leaseId} party={party} />
                    ) : (
                      <InviteForm
                        org={org} leaseId={leaseId} party={party} baseUrl={baseUrl}
                      />
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
