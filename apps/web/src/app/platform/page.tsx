import Link from 'next/link';
import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import {
  listCustomers, listPendingCustomers, listSignupRequests, platformHealth,
} from '@propertyos/domain';
import { readAs, readPrivilegedAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Platform' };
export const dynamic = 'force-dynamic';

const ACCOUNT_STATUS: Record<string, { tone: StatusTone; glyph: string }> = {
  trial:     { tone: 'info',     glyph: '◐' },
  active:    { tone: 'positive', glyph: '●' },
  suspended: { tone: 'critical', glyph: '▲' },
  closed:    { tone: 'neutral',  glyph: '■' },
};

export default async function PlatformPage() {
  const viewer = await requireViewer();
  const [customers, health, openRequests] = await readAs(viewer, async (tx) => [
    await listCustomers(tx, viewer.authUserId),
    await platformHealth(tx, viewer.authUserId),
    await listSignupRequests(tx, viewer.authUserId, { status: 'requested' }),
  ] as const);

  // A provisioned organisation with no members is invisible to every
  // membership-keyed policy, including for the operator who created it — so
  // one nobody accepted would sit there unnoticed. Read with the filtering
  // lifted and the operator's identity intact, so `listPendingCustomers`
  // still checks platform-operator status and the second factor in SQL. It
  // returns account metadata only: a name, an address and who was invited.
  const pending = await readPrivilegedAs(viewer, (tx) =>
    listPendingCustomers(tx, viewer.authUserId),
  );

  const overLimit = customers.filter((c) => c.overPlanLimit);
  const activeSessions = customers.reduce((s, c) => s + c.activeSupportSessions, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer organisations"
        description="Account metadata and usage. Customer records are not shown here and are not reachable from this page."
        actions={
          <Link
            href="/platform/new"
            className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-spike-600"
          >
            Set up a customer
          </Link>
        }
      />

      {openRequests.length > 0 ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-spike-500/25 bg-spike-50 p-4">
          <div>
            <p className="text-sm font-semibold text-ink-900">
              {openRequests.length} landlord{openRequests.length === 1 ? '' : 's'} asked for an
              account
            </p>
            <p className="text-sm text-ink-700">
              Sent through the public form. Nothing about them is verified and nothing is
              charged until you set the account up.
            </p>
          </div>
          <Link
            href="/platform/signups"
            className="rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Read the requests →
          </Link>
        </Card>
      ) : null}

      {pending.length > 0 ? (
        <section aria-labelledby="pending-heading" className="space-y-3">
          <h2
            id="pending-heading"
            className="text-sm font-semibold uppercase tracking-wide text-ink-500"
          >
            Waiting to be taken up
          </h2>
          <p className="text-sm text-ink-500">
            Set up, with nobody in them yet. Each one is invisible to everybody — including
            you — until its administrator accepts their invitation.
          </p>
          <Card className="divide-y divide-ink-100">
            {pending.map((customer) => (
              <div
                key={customer.organisationId}
                className="flex flex-wrap items-baseline justify-between gap-3 p-4"
              >
                <div>
                  <p className="text-sm font-medium text-ink-900">{customer.name}</p>
                  <p className="text-xs text-ink-500">
                    {customer.slug} · {customer.administratorName}{' '}
                    ({customer.administratorEmail}) · invited{' '}
                    {formatDate(customer.invitedAt, 'Africa/Johannesburg')}
                  </p>
                </div>
                <StatusBadge tone={customer.lapsed ? 'critical' : 'caution'} glyph="◐">
                  {customer.lapsed
                    ? 'the link has expired — set them up again'
                    : 'waiting to be accepted'}
                </StatusBadge>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <section aria-labelledby="health-heading" className="space-y-3">
        <h2 id="health-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Service health
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Queued jobs</p>
            <p className="tabular mt-1 text-2xl font-semibold">{health.queuedJobs}</p>
          </Card>
          <Card className={health.deadJobs > 0 ? 'border-critical-700/30 p-4' : 'p-4'}>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Failed jobs</p>
            <p className="tabular mt-1 text-2xl font-semibold">{health.deadJobs}</p>
            {health.deadJobs > 0 ? (
              <p className="mt-1 text-xs text-critical-700">Needs an operator to inspect</p>
            ) : null}
          </Card>
          <Card className={health.unpublishedOutbox > 50 ? 'border-caution-700/30 p-4' : 'p-4'}>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Unpublished events</p>
            <p className="tabular mt-1 text-2xl font-semibold">{health.unpublishedOutbox}</p>
            {health.oldestUnpublishedAt ? (
              <p className="mt-1 text-xs text-ink-400">
                oldest {formatDate(health.oldestUnpublishedAt)}
              </p>
            ) : null}
          </Card>
          <Card className={health.undeliveredNotifications > 0 ? 'border-caution-700/30 p-4' : 'p-4'}>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Undelivered messages</p>
            <p className="tabular mt-1 text-2xl font-semibold">{health.undeliveredNotifications}</p>
            {health.undeliveredNotifications > 0 ? (
              <p className="mt-1 text-xs text-caution-700">
                No email provider configured — these were NOT sent
              </p>
            ) : null}
          </Card>
        </div>
      </section>

      {activeSessions > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            {activeSessions} support session{activeSessions === 1 ? '' : 's'} currently open
          </p>
          <p className="mt-1 text-sm text-ink-700">
            Across every operator, not only your own. Each one is read-only, time limited,
            visible to the customer in their settings, and every action taken under it is
            recorded against it.
          </p>
        </Card>
      ) : null}

      {overLimit.length > 0 ? (
        <Card className="border-info-700/25 bg-info-50 p-4">
          <p className="text-sm font-semibold text-info-700">
            {overLimit.length} customer{overLimit.length === 1 ? '' : 's'} above plan allowance
          </p>
          <p className="mt-1 text-sm text-ink-700">
            They cannot add further units until they upgrade. Their existing records and billing
            are unaffected.
          </p>
        </Card>
      ) : null}

      {customers.length === 0 ? (
        <EmptyState title="No customer organisations" description="Provisioned customers appear here." />
      ) : (
        <DataTable
          caption="Customer organisations"
          head={
            <tr>
              <Th>Organisation</Th><Th>Status</Th><Th>Plan</Th>
              <Th numeric>Units</Th><Th numeric>Staff</Th><Th numeric>Active leases</Th>
              <Th>Region</Th><Th>Created</Th><Th>Support</Th>
            </tr>
          }
        >
          {customers.map((c) => {
            const status = ACCOUNT_STATUS[c.status] ?? ACCOUNT_STATUS.trial!;
            return (
              <tr key={c.organisationId} className="hover:bg-ink-50">
                <td className="px-4 align-middle">
                  <Link
                    href={`/platform/customers/${c.slug}`}
                    className="font-medium text-ink-900 underline decoration-ink-200 underline-offset-2 hover:decoration-ink-900"
                  >
                    {c.name}
                  </Link>
                  <p className="tabular text-xs text-ink-400">{c.slug}</p>
                </td>
                <Td><StatusBadge tone={status.tone} glyph={status.glyph}>{c.status}</StatusBadge></Td>
                <Td className="capitalize">{c.planKey ?? '—'}</Td>
                <Td numeric className="tabular">
                  {c.billableUnits}
                  {c.includedUnits !== null ? (
                    <span className={c.overPlanLimit ? 'text-critical-700' : 'text-ink-400'}>
                      {' '}/ {c.includedUnits}
                    </span>
                  ) : null}
                </Td>
                <Td numeric className="tabular">{c.memberCount}</Td>
                <Td numeric className="tabular">{c.activeLeases}</Td>
                <Td className="text-ink-500">{c.countryCode} · {c.currencyCode}</Td>
                <Td className="whitespace-nowrap text-ink-500">{formatDate(c.createdAt)}</Td>
                <Td>
                  {c.activeSupportSessions > 0
                    ? <StatusBadge tone="caution" glyph="●">{c.activeSupportSessions} open</StatusBadge>
                    : <span className="text-sm text-ink-400">—</span>}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}

      <p className="text-xs text-ink-400">
        This page shows counts only. No resident name, lease, balance or document is retrievable
        from it. Opening a customer record requires a support session recorded against a ticket
        reference, which the customer can see and revoke.
      </p>
    </div>
  );
}
