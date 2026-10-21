import { Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { supportAccessState } from '@propertyos/domain';
import { BackLink } from '@/components/back-link';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  ApproveSessionButton, CloseWindowButton, EndSessionButton, OpenWindowForm,
} from './decisions';

export const metadata = { title: 'Spike support access' };
export const dynamic = 'force-dynamic';

/**
 * Who at Spike may read this customer's records, decided here.
 *
 * This page used to be a log with a sentence promising a control it did not
 * have: "You can revoke access at any time", and no button. The control now
 * exists, and so does the one underneath it — until migration 0065 a session
 * Spike opened granted access the moment it was created, so there was never a
 * decision for this screen to offer.
 */
export default async function SupportAccessPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);
  const state = await readAs(context.viewer, (tx) =>
    supportAccessState(tx, context.organisationId),
  );

  const canDecide = context.roles.includes('org_admin');

  return (
    <div className="space-y-6">
      <BackLink href={`/app/${org}/settings`} label="Settings" />

      <PageHeader
        title="Spike support access"
        description="Nobody at Spike can read your records unless you let them. Every request, every approval and every look is recorded here."
      />

      {state.waiting.length > 0 ? (
        <section aria-labelledby="waiting-heading" className="space-y-3">
          <h2 id="waiting-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Waiting for you
          </h2>
          <Card className="divide-y divide-ink-100 border-info-700/25">
            {state.waiting.map((s) => (
              <div key={s.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="max-w-xl">
                  <p className="text-sm font-medium text-ink-900">
                    {s.operatorName} is asking to read your records
                  </p>
                  <p className="mt-0.5 text-sm text-ink-700">{s.reason}</p>
                  <p className="mt-1 text-xs text-ink-500">
                    Asked {formatDateTime(s.grantedAt, context.timeZone)} · read-only · would end{' '}
                    {formatDateTime(s.expiresAt, context.timeZone)} ·{' '}
                    <strong>reaches nothing until you approve it</strong>
                  </p>
                </div>
                {canDecide ? (
                  <div className="flex items-center gap-2">
                    <ApproveSessionButton
                      supportSessionId={s.id}
                      org={org}
                      operatorName={s.operatorName}
                    />
                    <EndSessionButton
                      supportSessionId={s.id}
                      org={org}
                      operatorName={s.operatorName}
                      waiting
                    />
                  </div>
                ) : (
                  <p className="text-xs text-ink-500">Only an administrator can decide this.</p>
                )}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {state.live.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            {state.live.length} support session{state.live.length === 1 ? ' is' : 's are'} open
          </p>
          <p className="mt-1 text-sm text-ink-700">
            Spike support can currently read your records. Sessions are read-only — support
            cannot change your data — and expire on their own. End one now with the button
            beside it; Spike then has to ask again.
          </p>
        </Card>
      ) : state.waiting.length === 0 ? (
        <Card className="border-positive-600/25 bg-positive-50 p-4">
          <p className="text-sm font-semibold text-positive-600">No open support sessions</p>
          <p className="mt-1 text-sm text-ink-700">
            Nobody at Spike can currently read your records.
          </p>
        </Card>
      ) : null}

      {canDecide ? (
        <section aria-labelledby="window-heading" className="space-y-3">
          <h2 id="window-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Letting support in in advance
          </h2>
          {state.openWindow ? (
            <Card className="flex flex-wrap items-start justify-between gap-3 border-caution-700/25 bg-caution-50 p-4">
              <div className="max-w-xl">
                <p className="text-sm font-semibold text-caution-700">
                  Support may let itself in until{' '}
                  {formatDateTime(state.openWindow.expiresAt, context.timeZone)}
                </p>
                <p className="mt-1 text-sm text-ink-700">
                  {state.openWindow.reason} · opened by{' '}
                  {state.openWindow.authorisedByName ?? 'an administrator'} ·{' '}
                  {state.openWindow.sessionsOpened} session
                  {state.openWindow.sessionsOpened === 1 ? '' : 's'} opened under it
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  Closing the window stops new sessions. Sessions already open under it keep
                  their own expiry and are ended one at a time, below — so you can see exactly
                  what you are taking away.
                </p>
              </div>
              <CloseWindowButton grantId={state.openWindow.id} org={org} />
            </Card>
          ) : (
            <OpenWindowForm org={org} />
          )}
        </section>
      ) : null}

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Everything Spike has asked for
        </h2>
        {state.sessions.length === 0 ? (
          <EmptyState
            title="Spike has never asked to open your account"
            description="If support ever needs to look at your records to help with a query, the request will appear here for you to approve or decline."
          />
        ) : (
          <DataTable
            caption="Spike support access history"
            head={
              <tr>
                <Th>Operator</Th><Th>Reason</Th><Th>Approved by</Th>
                <Th>Asked</Th><Th>Ends</Th><Th numeric>Records opened</Th><Th>State</Th>
                <Th>{''}</Th>
              </tr>
            }
          >
            {state.sessions.map((h) => (
              <tr key={h.id}>
                <Td className="font-medium">{h.operatorName}</Td>
                <Td>{h.reason}</Td>
                <Td className="text-ink-500">
                  {h.authorisedByName
                    ? (
                      <>
                        {h.authorisedByName}
                        {h.approvedViaGrant ? (
                          <span className="mt-0.5 block text-xs text-ink-400">
                            in advance, through a window
                          </span>
                        ) : null}
                      </>
                    )
                    : h.waiting
                      ? <StatusBadge tone="info" glyph="◐">Waiting for you</StatusBadge>
                      : <StatusBadge tone="neutral" glyph="○">Never approved</StatusBadge>}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(h.grantedAt, context.timeZone)}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(h.expiresAt, context.timeZone)}
                </Td>
                <Td numeric className="tabular">{h.actionsRecorded}</Td>
                <Td>
                  {h.revokedAt
                    ? (
                      <StatusBadge tone="neutral" glyph="■">
                        {h.approvedAt ? 'Ended' : 'Declined'}
                      </StatusBadge>
                    )
                    : h.live
                      ? <StatusBadge tone="caution" glyph="●">Open</StatusBadge>
                      : h.waiting
                        ? <StatusBadge tone="info" glyph="◐">Waiting</StatusBadge>
                        : <StatusBadge tone="neutral" glyph="○">Expired</StatusBadge>}
                  {h.readOnly ? (
                    <span className="mt-0.5 block text-xs text-ink-400">read-only</span>
                  ) : null}
                </Td>
                <Td>
                  {canDecide && (h.live || h.waiting) ? (
                    <EndSessionButton
                      supportSessionId={h.id}
                      org={org}
                      operatorName={h.operatorName}
                      waiting={h.waiting}
                    />
                  ) : null}
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      {state.grants.length > 0 ? (
        <section aria-labelledby="windows-heading" className="space-y-3">
          <h2 id="windows-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Windows you have opened
          </h2>
          <DataTable
            caption="Support access windows"
            head={
              <tr>
                <Th>Opened by</Th><Th>What for</Th><Th>From</Th><Th>Until</Th>
                <Th numeric>Sessions</Th><Th>State</Th>
              </tr>
            }
          >
            {state.grants.map((g) => (
              <tr key={g.id}>
                <Td className="font-medium">{g.authorisedByName ?? '—'}</Td>
                <Td>{g.reason}</Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(g.grantedAt, context.timeZone)}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(g.expiresAt, context.timeZone)}
                </Td>
                <Td numeric className="tabular">{g.sessionsOpened}</Td>
                <Td>
                  {g.revokedAt
                    ? <StatusBadge tone="neutral" glyph="■">Closed early</StatusBadge>
                    : g.live
                      ? <StatusBadge tone="caution" glyph="●">Open</StatusBadge>
                      : <StatusBadge tone="neutral" glyph="○">Expired</StatusBadge>}
                </Td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}
    </div>
  );
}
