import { notFound } from 'next/navigation';
import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import {
  customerDetail, formatMoney, listCustomers, listPlans, organisationPermissionOverrides,
  organisationSettings, permissionCatalogue, platformPermissionsOf,
} from '@propertyos/domain';
import { BackLink } from '@/components/back-link';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  AccountStatusForm, CloseSessionButton, PlanForm, SupportSessionForm,
} from './customer-forms';
import { PermissionOverrides } from './permission-forms';
import { CustomerSettings } from '../../settings/setting-forms';

export const dynamic = 'force-dynamic';

const ACCOUNT_STATUS: Record<string, { tone: StatusTone; glyph: string }> = {
  trial:     { tone: 'info',     glyph: '◐' },
  active:    { tone: 'positive', glyph: '●' },
  suspended: { tone: 'critical', glyph: '▲' },
  closed:    { tone: 'neutral',  glyph: '■' },
};

/** `platform.plan.changed` is not what an operator should have to read. */
const ACTION_LABEL: Record<string, string> = {
  'platform.customer.provisioned': 'Account set up',
  'platform.plan.changed': 'Plan changed',
  'platform.account.status_changed': 'Account status changed',
  'platform.support_session.opened': 'Support session opened',
  'platform.support_session.closed': 'Support session closed',
};

function change(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const from = before?.planKey ?? before?.status;
  const to = after?.planKey ?? after?.status;
  if (typeof from === 'string' && typeof to === 'string') return `${from} → ${to}`;
  if (typeof to === 'string') return to;
  return '—';
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug };
}

export default async function PlatformCustomerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const viewer = await requireViewer();

  // The slug is untrusted input, resolved against the customer list the
  // operator may already see rather than queried directly, so an unknown slug
  // is a 404 with nothing in it.
  const customers = await readAs(viewer, (tx) => listCustomers(tx, viewer.authUserId));
  const match = customers.find((c) => c.slug === slug);
  if (!match) notFound();

  const [detail, plans, catalogue, overrides, mine, settings] = await readAs(viewer, async (tx) => [
    await customerDetail(tx, viewer.authUserId, match.organisationId),
    await listPlans(tx),
    // What every role can do, so the form can offer only what this role does
    // not already carry — the database refuses the rest anyway.
    await permissionCatalogue(tx, viewer.authUserId),
    await organisationPermissionOverrides(tx, match.organisationId),
    await platformPermissionsOf(tx, viewer.authUserId),
    await organisationSettings(tx, match.organisationId),
  ] as const);

  const status = ACCOUNT_STATUS[detail.status] ?? ACCOUNT_STATUS.trial!;
  const openSessions = detail.supportSessions.filter((s) => s.open);
  const waitingSessions = detail.supportSessions.filter((s) => s.waiting);
  const planOptions = plans.map((p) => ({
    key: p.key,
    name: p.name,
    includedUnits: p.includedUnits,
    priceLabel: p.monthlyPriceMinor === 0
      ? 'priced separately'
      : `${formatMoney(p.monthlyPriceMinor, p.currencyCode)}/month`,
  }));

  return (
    <div className="space-y-6">
      <BackLink href="/platform" label="Customer organisations" />

      <PageHeader
        title={detail.name}
        description={`${detail.slug} · ${detail.countryCode} · ${detail.currencyCode} · set up ${formatDate(detail.createdAt)}`}
        actions={<StatusBadge tone={status.tone} glyph={status.glyph}>{detail.status}</StatusBadge>}
      />

      {detail.status === 'suspended' || detail.status === 'closed' ? (
        <Card className="border-critical-700/25 bg-critical-50 p-4">
          <p className="text-sm font-semibold text-critical-700">
            This account is {detail.status}, so its staff cannot open the console
          </p>
          <p className="mt-1 text-sm text-ink-700">
            Their records, contracts and financial history are untouched and their residents
            keep their portal. Set the status back to active to restore access.
          </p>
        </Card>
      ) : null}

      <section aria-labelledby="commercial" className="space-y-3">
        <h2 id="commercial" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          What they are on
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Plan</p>
            <p className="mt-1 text-2xl font-semibold capitalize">{detail.plan?.name ?? '—'}</p>
            <p className="mt-1 text-xs text-ink-400">
              subscription {detail.subscriptionStatus ?? 'none'}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              At today&rsquo;s usage
            </p>
            <p className="tabular mt-1 text-2xl font-semibold">
              {detail.monthlyChargeMinor === null
                ? '—'
                : formatMoney(detail.monthlyChargeMinor, detail.plan?.currencyCode ?? 'ZAR')}
            </p>
            <p className="mt-1 text-xs text-ink-400">
              {detail.unitsOverAllowance > 0 && detail.plan
                ? `${detail.plan.name} plus ${detail.unitsOverAllowance} unit(s) over`
                : 'plan price, nothing over'}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Active leases</p>
            <p className="tabular mt-1 text-2xl font-semibold">{detail.activeLeases}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Staff with access</p>
            <p className="tabular mt-1 text-2xl font-semibold">{detail.activeMembers}</p>
            <p className="mt-1 text-xs text-ink-400">invitations not yet accepted excluded</p>
          </Card>
        </div>

        <Card className="divide-y divide-ink-100">
          {detail.allowances.map((a) => (
            <div key={a.feature} className="flex items-baseline justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-medium text-ink-900">{a.label}</p>
                <p className="text-xs text-ink-500">
                  {a.limit === null
                    ? 'no limit on this plan'
                    : a.withinLimit
                      ? `${a.limit - a.used} left of ${a.limit}`
                      : `${a.used - a.limit} beyond the allowance — they cannot add more`}
                </p>
              </div>
              <p className={`tabular text-lg font-semibold ${a.withinLimit ? '' : 'text-critical-700'}`}>
                {a.used}
                <span className="text-sm font-normal text-ink-400">
                  {a.limit === null ? '' : ` / ${a.limit}`}
                </span>
              </p>
            </div>
          ))}
        </Card>
        <p className="text-xs text-ink-400">
          Counts come from a function that returns numbers only. No resident, lease, balance or
          document is reachable from this page, and nothing here invoices the customer —
          subscription billing does not exist in this product yet.
        </p>
      </section>

      <section aria-labelledby="controls" className="space-y-3">
        <h2 id="controls" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Change something
        </h2>
        <div className="grid gap-3 lg:grid-cols-3">
          <PlanForm
            organisationId={detail.organisationId}
            slug={detail.slug}
            planKey={detail.plan?.key ?? null}
            plans={planOptions}
            billableUnits={detail.billableUnits}
          />
          <AccountStatusForm
            organisationId={detail.organisationId}
            slug={detail.slug}
            status={detail.status}
          />
          <SupportSessionForm
            organisationId={detail.organisationId}
            slug={detail.slug}
            openWindow={detail.openWindow}
          />
          <CustomerSettings
            organisationId={detail.organisationId}
            slug={detail.slug}
            customerName={detail.name}
            settings={settings}
            canManage={mine.includes('platform.config.manage')}
          />
          <PermissionOverrides
            organisationId={detail.organisationId}
            slug={detail.slug}
            customerName={detail.name}
            roles={catalogue.roles.map((r) => ({
              key: r.key, name: r.name, assignableToStaff: r.assignableToStaff,
              permissions: r.permissions,
            }))}
            permissions={catalogue.permissions.map((p) => ({
              key: p.key, description: p.description,
            }))}
            overrides={overrides}
            canManage={mine.includes('platform.permissions.manage')}
          />
        </div>
      </section>

      <section aria-labelledby="sessions" className="space-y-3">
        <h2 id="sessions" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Support access
        </h2>
        {openSessions.length > 0 ? (
          <Card className="border-caution-700/25 bg-caution-50 p-4">
            <p className="text-sm font-semibold text-caution-700">
              {openSessions.length} approved session{openSessions.length === 1 ? '' : 's'} open
              right now
            </p>
            <p className="mt-1 text-sm text-ink-700">
              Including colleagues&rsquo;. The customer can end any of them from their own
              settings, and so can the operator who opened it.
            </p>
          </Card>
        ) : null}

        {waitingSessions.length > 0 ? (
          <Card className="border-info-700/25 bg-info-50 p-4">
            <p className="text-sm font-semibold text-info-700">
              {waitingSessions.length} request{waitingSessions.length === 1 ? '' : 's'} waiting on
              the customer
            </p>
            <p className="mt-1 text-sm text-ink-700">
              A session nobody has approved reads nothing at all. It is showing on their support
              access screen with the operator&rsquo;s name and reason.
            </p>
          </Card>
        ) : null}

        {detail.supportSessions.length === 0 ? (
          <EmptyState
            title="Spike has never opened this account"
            description="A support session is the only route to this customer's records, and there has not been one."
          />
        ) : (
          <DataTable
            caption="Support sessions"
            head={
              <tr>
                <Th>Operator</Th><Th>Reason</Th><Th>Opened</Th><Th>Expires</Th>
                <Th numeric>Records opened</Th><Th>State</Th><Th>{''}</Th>
              </tr>
            }
          >
            {detail.supportSessions.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">
                  {s.operatorName}
                  {s.openedByMe ? <span className="text-xs text-ink-400"> (you)</span> : null}
                </Td>
                <Td>{s.reason}</Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(s.grantedAt, detail.timeZone)}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(s.expiresAt, detail.timeZone)}
                </Td>
                <Td numeric className="tabular">{s.actionsRecorded}</Td>
                <Td>
                  {s.revokedAt
                    ? <StatusBadge tone="neutral" glyph="■">Ended</StatusBadge>
                    : s.open
                      ? <StatusBadge tone="caution" glyph="●">Approved</StatusBadge>
                      : s.waiting
                        ? <StatusBadge tone="info" glyph="◐">Waiting on the customer</StatusBadge>
                        : <StatusBadge tone="neutral" glyph="○">Expired</StatusBadge>}
                  {s.waiting ? (
                    <span className="mt-0.5 block text-xs text-ink-400">reaches nothing yet</span>
                  ) : s.customerAuthorised ? (
                    <span className="mt-0.5 block text-xs text-ink-400">
                      {s.approvedViaWindow ? 'approved in advance' : 'approved by the customer'}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {s.open && s.openedByMe ? (
                      // The way in. The console refuses anybody without a live
                      // approved session of their own, so this link is the only
                      // thing that was missing — and it is offered only on a
                      // session that is actually open, and yours.
                      <a
                        href={`/app/${detail.slug}`}
                        className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
                      >
                        Open their console →
                      </a>
                    ) : null}
                    {(s.open || s.waiting) && s.openedByMe
                      ? <CloseSessionButton supportSessionId={s.id} slug={detail.slug} />
                      : null}
                  </div>
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section aria-labelledby="trail" className="space-y-3">
        <h2 id="trail" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          What Spike has done to this account
        </h2>
        {detail.platformActions.length === 0 ? (
          <EmptyState title="Nothing recorded" description="Platform actions against this customer appear here." />
        ) : (
          <DataTable
            caption="Platform actions"
            head={<tr><Th>When</Th><Th>What</Th><Th>Change</Th><Th>Who</Th><Th>Why</Th></tr>}
          >
            {detail.platformActions.map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(a.at, detail.timeZone)}
                </Td>
                <Td>{ACTION_LABEL[a.action] ?? a.action}</Td>
                <Td className="tabular text-ink-700">{change(a.before, a.after)}</Td>
                <Td className="text-ink-700">{a.actorName ?? 'a Spike operator'}</Td>
                <Td className="text-ink-500">{a.reason ?? '—'}</Td>
              </tr>
            ))}
          </DataTable>
        )}
        <p className="text-xs text-ink-400">
          The same entries appear in the customer&rsquo;s own audit history. This view is
          limited to <span className="font-mono">platform.*</span> actions: what Spike did,
          not what the customer did.
        </p>
      </section>
    </div>
  );
}
