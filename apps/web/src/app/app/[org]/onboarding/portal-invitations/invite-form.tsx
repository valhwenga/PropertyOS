'use client';

import { useActionState, useState } from 'react';
import { Button, Card, DataTable, ErrorState, Td, Th } from '@propertyos/ui';
import { issueBulkInvitationsAction } from './actions';

/**
 * Choosing who to invite, and reading back the links.
 *
 * The links are the product of this screen and they are shown ONCE: only a
 * hash is stored, so neither this screen nor anybody else can recover them
 * afterwards. That is why they come back as a block somebody can copy in one
 * action as well as a table they can read — a landlord with forty links to
 * distribute should not be re-issuing twenty of them because the page was
 * closed.
 */

export interface Candidate {
  key: string;
  leaseReference: string;
  unitLabel: string;
  residentName: string;
  email: string | null;
  blockedReason: string | null;
}

interface Outcome {
  ok?: boolean;
  message?: string;
  correlationId?: string;
  issued?: Array<{
    residentName: string; leaseReference: string; email: string;
    token: string; expiresAt: string;
  }>;
  failed?: Array<{ residentName: string; reason: string }>;
}

export function BulkInviteForm({
  org, candidates, baseUrl,
}: {
  org: string; candidates: Candidate[]; baseUrl: string;
}) {
  const [state, action, pending] = useActionState(issueBulkInvitationsAction, null);
  const invitable = candidates.filter((c) => !c.blockedReason);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const outcome = state?.ok ? (state as Outcome) : null;

  if (outcome?.issued) {
    const lines = outcome.issued
      .map((i) => `${i.residentName}\t${i.email}\t${baseUrl}/tenancy/${i.token}`)
      .join('\n');
    return (
      <div className="space-y-4">
        <Card className="border-positive-600/25 bg-positive-50 p-4">
          <p className="text-sm font-semibold text-positive-600">
            {outcome.issued.length} invitation{outcome.issued.length === 1 ? '' : 's'} issued
          </p>
          <p className="mt-1 text-sm text-ink-700">
            <strong>No email has been sent and none is claimed.</strong> Give each person their
            own link. Each one is shown here once: only a hash is stored, so nobody — including
            this screen — can recover it afterwards.
          </p>
        </Card>

        {outcome.failed && outcome.failed.length > 0 ? (
          <Card className="border-caution-700/25 bg-caution-50 p-4">
            <p className="text-sm font-semibold text-caution-700">
              {outcome.failed.length} were not invited
            </p>
            <ul className="mt-1 space-y-1 text-sm text-ink-700">
              {outcome.failed.map((f) => (
                <li key={f.residentName}>{f.residentName} — {f.reason}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        <DataTable
          caption="Invitations issued"
          head={<tr><Th>Resident</Th><Th>Lease</Th><Th>Email</Th><Th>Their link</Th></tr>}
        >
          {outcome.issued.map((i) => (
            <tr key={i.token}>
              <Td className="font-medium">{i.residentName}</Td>
              <Td className="technical text-ink-700">{i.leaseReference}</Td>
              <Td className="text-ink-700">{i.email}</Td>
              <Td>
                <span className="break-all font-mono text-xs">
                  {baseUrl}/tenancy/{i.token}
                </span>
              </Td>
            </tr>
          ))}
        </DataTable>

        <div className="space-y-1.5">
          <label htmlFor="copy-all" className="block text-sm font-medium text-ink-700">
            All of them, to copy in one go
          </label>
          <textarea
            id="copy-all" readOnly rows={Math.min(10, outcome.issued.length + 1)}
            value={lines}
            className="w-full rounded-lg border border-ink-200 bg-surface p-3 font-mono text-xs"
          />
          <p className="text-xs text-ink-500">
            Name, email address and link, separated by tabs — it pastes into a spreadsheet or a
            mail merge as three columns.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="org" value={org} />

      {state && !state.ok ? (
        <ErrorState
          title="No invitations were issued"
          detail={state.message ?? 'Nothing was sent.'}
          correlationId={state.correlationId}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => setSelected(new Set(invitable.map((c) => c.key)))}
        >
          Select all {invitable.length}
        </Button>
        <Button type="button" onClick={() => setSelected(new Set())}>Clear</Button>
        <span className="text-sm text-ink-500">
          {selected.size} chosen
        </span>
      </div>

      <DataTable
        caption="Residents without portal access"
        head={
          <tr>
            <Th>{''}</Th><Th>Resident</Th><Th>Home</Th><Th>Lease</Th><Th>Email</Th>
          </tr>
        }
      >
        {candidates.map((c) => (
          <tr key={c.key} className={c.blockedReason ? 'opacity-60' : undefined}>
            <Td>
              {c.blockedReason ? null : (
                <>
                  <input
                    type="checkbox" name="invite" value={c.key}
                    checked={selected.has(c.key)}
                    onChange={(event) => setSelected((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(c.key); else next.delete(c.key);
                      return next;
                    })}
                    aria-label={`Invite ${c.residentName}`}
                  />
                  {/* The name and address the operator is looking at travel with
                      the choice, and the server compares the name with the
                      resident on the lease before it sends anything. */}
                  <input type="hidden" name={`name:${c.key}`} value={c.residentName} />
                  <input type="hidden" name={`email:${c.key}`} value={c.email ?? ''} />
                </>
              )}
            </Td>
            <Td className="font-medium">{c.residentName}</Td>
            <Td className="text-ink-700">{c.unitLabel}</Td>
            <Td className="technical text-ink-700">{c.leaseReference}</Td>
            <Td className="text-ink-700">
              {c.email ?? <span className="text-xs text-caution-700">{c.blockedReason}</span>}
            </Td>
          </tr>
        ))}
      </DataTable>

      <Button type="submit" variant="primary" disabled={pending || selected.size === 0}>
        {pending
          ? 'Issuing…'
          : `Issue ${selected.size || ''} invitation${selected.size === 1 ? '' : 's'}`}
      </Button>
    </form>
  );
}
