import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMoney } from '@propertyos/domain/money';
import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadResidentDetail } from '@/lib/operations-queries';

export const metadata = { title: 'Resident' };
export const dynamic = 'force-dynamic';

const LEASE_TONE: Record<string, StatusTone> = {
  active: 'positive', notice_given: 'caution', awaiting_execution: 'info',
  draft: 'neutral', expired: 'neutral', closed: 'neutral', cancelled: 'neutral',
};

const PORTAL_TONE: Record<string, StatusTone> = {
  active: 'positive', invited: 'info', revoked: 'neutral', expired: 'caution',
};

const PREFERENCE: Record<string, string> = {
  email: 'Email',
  in_app: 'In the portal only — not emailed',
  none: 'No notices — not emailed',
};

/**
 * One resident: their leases, their portal access, how to reach them.
 *
 * The Residents table has linked every name here since it was built and nothing
 * answered, so every one of those links was a 404.
 *
 * The identity number stays masked. Reading it in full needs
 * `resident.identity.read`, which is a separate permission from ordinary
 * resident access, and a summary page is not the place to quietly spend it.
 */
export default async function ResidentPage({
  params,
}: {
  params: Promise<{ org: string; residentId: string }>;
}) {
  const { org, residentId } = await params;
  const context = await requireOperator(org);
  const detail = await readAs(context.viewer, (tx) =>
    loadResidentDetail(tx, context.organisationId, residentId),
  );
  if (!detail) notFound();

  const { resident, leases, portal } = detail;
  const name = `${resident.first_name} ${resident.last_name}`.trim();

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/residents`} className="text-sm text-spike-600 hover:underline">
        ← All residents
      </Link>

      <PageHeader
        title={name}
        description={`On file since ${formatDate(resident.created_at, context.timeZone)}.`}
      />

      <Card className="p-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Email</dt>
            <dd className="mt-1 break-words text-sm text-ink-900">{resident.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Phone</dt>
            <dd className="mt-1 text-sm text-ink-900">{resident.phone ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Identity number
            </dt>
            {/* Masked, as in every list view. The last four digits are enough to
                confirm you have the right person. */}
            <dd className="mt-1 tabular text-sm text-ink-900">
              {resident.identity_number_last4 ? `••••••• ${resident.identity_number_last4}` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              How they are contacted
            </dt>
            <dd className="mt-1 text-sm text-ink-900">
              {PREFERENCE[resident.communication_preference] ?? resident.communication_preference}
            </dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge tone={resident.status === 'active' ? 'positive' : 'neutral'}>
            {resident.status}
          </StatusBadge>
          {resident.date_of_birth ? (
            <span className="text-sm text-ink-500">
              Born {formatDate(resident.date_of_birth, context.timeZone)}
            </span>
          ) : null}
        </div>
        {resident.notes ? (
          <p className="mt-4 whitespace-pre-line border-t border-ink-100 pt-4 text-sm text-ink-700">
            {resident.notes}
          </p>
        ) : null}
      </Card>

      {leases.length === 0 ? (
        <EmptyState
          title="No leases"
          description="This person is on file but holds no lease. Draft one when they take a unit."
          action={
            <Link
              href={`/app/${org}/leases/new`}
              className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
            >
              Draft a lease
            </Link>
          }
        />
      ) : (
        <DataTable
          caption={`Leases held by ${name}`}
          head={
            <tr>
              <Th>Lease</Th><Th>Unit</Th><Th>Role</Th>
              <Th>From</Th><Th>To</Th><Th numeric>Rent</Th><Th>Status</Th>
            </tr>
          }
        >
          {leases.map((l) => (
            <tr key={`${l.id}-${l.role}`} className="hover:bg-ink-50">
              <Td>
                <Link
                  href={`/app/${org}/leases/${l.id}`}
                  className="font-medium text-spike-600 hover:underline"
                >
                  {l.reference}
                </Link>
              </Td>
              <Td className="text-ink-500">{l.unit_label}</Td>
              <Td className="capitalize text-ink-500">{l.role.replace(/_/g, ' ')}</Td>
              <Td className="whitespace-nowrap text-ink-500">
                {formatDate(l.start_date, context.timeZone)}
              </Td>
              <Td className="whitespace-nowrap text-ink-500">
                {l.end_date ? formatDate(l.end_date, context.timeZone) : '—'}
              </Td>
              {/* The lease's rent, not this person's share of it. Joint parties
                  do not each owe the full amount, and the receivable belongs to
                  the lease account. */}
              <Td numeric className="tabular">{formatMoney(l.rent_minor, context.currencyCode)}</Td>
              <Td>
                <StatusBadge tone={LEASE_TONE[l.status] ?? 'neutral'}>
                  {l.status.replace(/_/g, ' ')}
                </StatusBadge>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}

      <Card className="p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Portal access
        </h2>
        {portal.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">
            No portal invitation. A resident can hold a lease without ever having a login —
            access is issued per lease and can be revoked.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {portal.map((p) => (
              <li key={`${p.lease_reference}-${p.invited_at}`} className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge tone={PORTAL_TONE[p.status] ?? 'neutral'}>{p.status}</StatusBadge>
                <span className="text-ink-700">{p.lease_reference}</span>
                <span className="break-all text-ink-500">{p.invited_email}</span>
                <span className="text-xs text-ink-400">
                  {p.accepted_at
                    ? `accepted ${formatDate(p.accepted_at, context.timeZone)}`
                    : `invited ${formatDate(p.invited_at, context.timeZone)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
