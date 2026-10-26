import Link from 'next/link';
import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import {
  platformAuditChoices, platformAuditSummary, platformAuditTrail, supportScopes,
} from '@propertyos/domain';
import { readPrivilegedAs, requireViewer } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'What Spike has done' };
export const dynamic = 'force-dynamic';

/**
 * Spike's own conduct, in one place.
 *
 * Two kinds of row, and the screen keeps them distinguishable because they
 * answer different questions: a `platform.%` action is Spike acting on an
 * ACCOUNT — a plan, a suspension, an operator, an invoice — and a row carrying
 * a support session is something done inside a customer's own RECORDS. The
 * second is the one a reviewer came for.
 *
 * A session row is not always Spike's: approving a session and ending one
 * carry the session id too, so the customer's own decisions about the session
 * appear beside the work done under it. That is deliberate — "who agreed to
 * this, and who stopped it" is the half of the chain that makes the other half
 * legitimate — and it is why the description says what it says rather than
 * claiming the customer never appears at all.
 *
 * What it never shows is the customer's ORDINARY work: their staff creating a
 * resident, posting a billing run, editing a lease. Those rows are in the same
 * table and a live session can technically read them; `platformAuditTrail`
 * filters to the session-stamped and platform rows instead, because a review
 * tool that quietly becomes a window into customer data is the thing the whole
 * support-session design exists to prevent.
 *
 * Read privileged for the usual platform reason — an operator is a member of
 * nothing — with the operator's identity intact, so the permission is still
 * resolved in SQL.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-xs font-medium uppercase tracking-wide text-ink-500';

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string; operator?: string; customer?: string; action?: string;
    from?: string; to?: string;
  }>;
}) {
  const viewer = await requireViewer();
  const q = await searchParams;

  const kind: 'all' | 'platform' | 'support' =
    q.kind === 'platform' || q.kind === 'support' ? q.kind : 'all';
  const filter = {
    kind,
    ...(q.operator ? { operatorUserId: q.operator } : {}),
    ...(q.customer ? { organisationId: q.customer } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
  };

  const { trail, choices, summary, scopes } = await readPrivilegedAs(viewer, async (tx) => ({
    trail: await platformAuditTrail(tx, viewer.authUserId, filter),
    choices: await platformAuditChoices(tx, viewer.authUserId),
    summary: await platformAuditSummary(tx, viewer.authUserId),
    scopes: await supportScopes(tx),
  }));

  const scopeName = (key: string) => scopes.find((s) => s.key === key)?.name ?? key;
  const exportQuery = new URLSearchParams(
    Object.entries({ ...q }).filter(([, v]) => Boolean(v)) as [string, string][],
  ).toString();

  return (
    <div className="space-y-6">
      <PageHeader
        title="What Spike has done"
        description="Every action Spike has taken on a customer's account or inside their records, and the customer's own decisions about those sessions — who approved one, who ended it. Their ordinary work never appears here."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Account actions, 30 days
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{summary.platformActions}</p>
          <p className="mt-1 text-xs text-ink-400">plans, suspensions, operators, invoices</p>
        </Card>
        <Card className={summary.actionsUnderSessions > 0 ? 'border-caution-700/30 p-4' : 'p-4'}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Changes inside customer records
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{summary.actionsUnderSessions}</p>
          <p className="mt-1 text-xs text-ink-400">all of them under an authorised session</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Sessions used
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{summary.sessionsUsed}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Customers visited
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{summary.customersTouched}</p>
        </Card>
      </div>

      <Card className="p-4">
        {/* A GET form, so a filtered view is a URL somebody can send to a
            colleague — which is what a review actually involves. */}
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <label className={LABEL} htmlFor="kind">Showing</label>
            <select id="kind" name="kind" defaultValue={kind} className={`mt-1 ${FIELD}`}>
              <option value="all">Everything</option>
              <option value="support">Inside customer records</option>
              <option value="platform">Account actions only</option>
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="operator">Operator</label>
            <select id="operator" name="operator" defaultValue={q.operator ?? ''} className={`mt-1 ${FIELD}`}>
              <option value="">Anybody</option>
              {choices.operators.map((o) => (
                <option key={o.authUserId} value={o.authUserId}>
                  {o.fullName} ({o.actions})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="customer">Customer</label>
            <select id="customer" name="customer" defaultValue={q.customer ?? ''} className={`mt-1 ${FIELD}`}>
              <option value="">Any</option>
              {choices.customers.map((c) => (
                <option key={c.organisationId} value={c.organisationId}>
                  {c.name} ({c.actions})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="action">Action</label>
            <select id="action" name="action" defaultValue={q.action ?? ''} className={`mt-1 ${FIELD}`}>
              <option value="">Any</option>
              {choices.actions.map((a) => (
                <option key={a.action} value={a.action}>{a.action} ({a.actions})</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="from">From</label>
            <input
              id="from" name="from" type="date" defaultValue={q.from ?? ''}
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="to">To</label>
            <input
              id="to" name="to" type="date" defaultValue={q.to ?? ''}
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
            <button
              type="submit"
              className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-spike-600"
            >
              Apply
            </button>
            <Link
              href="/platform/audit"
              className="rounded-lg border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              Clear
            </Link>
            <a
              href={`/platform/audit/export.csv${exportQuery ? `?${exportQuery}` : ''}`}
              className="ml-auto rounded-lg border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              Download this view
            </a>
          </div>
        </form>
      </Card>

      {trail.rows.length === 0 ? (
        <EmptyState
          title="Nothing matches that"
          description="No action on an account, and nothing inside a customer's records, fits these filters."
        />
      ) : (
        <section aria-labelledby="trail-heading" className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="trail-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              {trail.total} action{trail.total === 1 ? '' : 's'}
            </h2>
            {trail.capped ? (
              <p className="text-xs text-caution-700">
                Showing the most recent {trail.rows.length}. Narrow the dates to see the rest —
                this page is not the whole answer.
              </p>
            ) : null}
          </div>
          <DataTable
            caption="Actions by Spike, most recent first"
            head={
              <tr>
                <Th>When</Th><Th>Operator</Th><Th>Action</Th><Th>Customer</Th>
                <Th>Why</Th><Th>Under a session</Th>
              </tr>
            }
          >
            {trail.rows.map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDateTime(row.at, 'Africa/Johannesburg')}
                </Td>
                <Td className="font-medium">{row.actorName ?? 'unattributed'}</Td>
                <Td className="tabular text-xs">{row.action}</Td>
                <Td>
                  {row.organisationSlug ? (
                    <Link
                      href={`/platform/customers/${row.organisationSlug}`}
                      className="text-spike-600 hover:underline"
                    >
                      {row.organisationName}
                    </Link>
                  ) : (
                    <span className="text-ink-400">Spike itself</span>
                  )}
                </Td>
                <Td className="max-w-sm text-ink-700">{row.reason ?? ''}</Td>
                <Td>
                  {row.supportSessionId ? (
                    <>
                      <StatusBadge tone="caution" glyph="●">inside their records</StatusBadge>
                      <span className="mt-0.5 block text-xs text-ink-500">
                        {row.supportScopes.length === 0
                          ? 'read-only session'
                          : `allowed: ${row.supportScopes.map(scopeName).join(', ')}`}
                        {row.approvedByName ? ` · approved by ${row.approvedByName}` : ''}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-ink-400">on the account</span>
                  )}
                </Td>
              </tr>
            ))}
          </DataTable>
        </section>
      )}
    </div>
  );
}
