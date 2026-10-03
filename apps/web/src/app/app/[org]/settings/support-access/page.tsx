import { Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { supportAccessHistory } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'Spike support access' };
export const dynamic = 'force-dynamic';

export default async function SupportAccessPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);
  const history = await readAs(context.viewer, (tx) =>
    supportAccessHistory(tx, context.organisationId),
  );

  const now = Date.now();
  const active = history.filter(
    (h) => !h.revokedAt && new Date(h.expiresAt).getTime() > now,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spike support access"
        description="Every time Spike support opens your account, it is recorded here with who, when, why and for how long."
      />

      {active.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            {active.length} support session{active.length === 1 ? ' is' : 's are'} currently open
          </p>
          <p className="mt-1 text-sm text-ink-700">
            Spike support can currently read your records. Sessions are read-only — support
            cannot change your data — and expire automatically. You can revoke access at any
            time.
          </p>
        </Card>
      ) : (
        <Card className="border-positive-600/25 bg-positive-50 p-4">
          <p className="text-sm font-semibold text-positive-600">No open support sessions</p>
          <p className="mt-1 text-sm text-ink-700">
            Nobody at Spike can currently read your records.
          </p>
        </Card>
      )}

      {history.length === 0 ? (
        <EmptyState
          title="Spike has never accessed your account"
          description="If support ever needs to look at your records to help with a query, it will be logged here."
        />
      ) : (
        <DataTable
          caption="Spike support access history"
          head={
            <tr>
              <Th>Operator</Th><Th>Reason</Th><Th>Authorised by</Th>
              <Th>Opened</Th><Th>Expires</Th><Th numeric>Actions</Th><Th>State</Th>
            </tr>
          }
        >
          {history.map((h) => {
            const expired = new Date(h.expiresAt).getTime() <= now;
            return (
              <tr key={h.id}>
                <Td className="font-medium">{h.operatorName}</Td>
                <Td>{h.reason}</Td>
                <Td className="text-ink-500">
                  {h.authorisedByName ?? (
                    <StatusBadge tone="caution" glyph="▲">Not authorised by you</StatusBadge>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(h.grantedAt, context.timeZone)}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(h.expiresAt, context.timeZone)}
                </Td>
                <Td numeric className="tabular">{h.actionsRecorded}</Td>
                <Td>
                  {h.revokedAt ? <StatusBadge tone="neutral" glyph="■">Revoked</StatusBadge>
                    : expired ? <StatusBadge tone="neutral" glyph="○">Expired</StatusBadge>
                    : <StatusBadge tone="caution" glyph="●">Open</StatusBadge>}
                  {h.readOnly ? (
                    <span className="mt-0.5 block text-xs text-ink-400">read-only</span>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}
