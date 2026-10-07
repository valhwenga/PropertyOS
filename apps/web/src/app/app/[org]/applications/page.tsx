import { Card, EmptyState, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { listApplicationLinks, listRentalApplications } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { ApplicationDecision, LinkControls, NewLinkForm } from './application-controls';

export const metadata = { title: 'Applications' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, StatusTone> = {
  received: 'info', screening: 'caution', approved: 'positive',
  declined: 'critical', withdrawn: 'neutral',
};

export default async function ApplicationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const [links, applications] = await readAs(context.viewer, async (tx) => [
    await listApplicationLinks(tx, context.organisationId),
    await listRentalApplications(tx, context.organisationId),
  ] as const);

  const baseUrl = process.env.APP_BASE_URL ?? '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description="Links you can share anywhere, and what came back through them."
      />

      <section aria-labelledby="links" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="links" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Application links
          </h2>
          <NewLinkForm org={org} />
        </div>

        {links.length === 0 ? (
          <EmptyState
            title="No application links yet"
            description="Create one and put it on a listing, a poster or a message. Anyone with the link can apply; nobody with it can read an application."
          />
        ) : (
          <Card className="divide-y divide-ink-100 p-0">
            {links.map((l) => (
              <div key={l.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">
                      {l.label}
                      {l.active ? null : (
                        <span className="ml-2 align-middle">
                          <StatusBadge tone="neutral">Revoked</StatusBadge>
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-ink-500">
                      {l.unitLabel ? `${l.unitLabel} · ` : ''}
                      {l.received} {l.received === 1 ? 'application' : 'applications'} ·
                      created {formatDate(l.createdAt, context.timeZone)}
                    </p>
                  </div>
                  <LinkControls org={org} linkId={l.id} active={l.active}
                                url={`${baseUrl}/apply/${l.token}`} />
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section aria-labelledby="applications" className="space-y-3">
        <h2 id="applications" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Applications received
        </h2>

        {applications.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Applications submitted through your links appear here."
          />
        ) : (
          <div className="space-y-3">
            {applications.map((a) => (
              <Card key={a.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink-900">
                      {a.fullName}
                      <span className="ml-2 align-middle">
                        <StatusBadge tone={STATUS[a.status] ?? 'neutral'}>{a.status}</StatusBadge>
                      </span>
                    </p>
                    <p className="tabular text-xs text-ink-500">
                      {a.reference} · via {a.linkLabel} ·{' '}
                      {formatDate(a.submittedAt, context.timeZone)}
                    </p>
                  </div>
                </div>

                <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {[
                    ['Email', a.email], ['Phone', a.phone],
                    ['Lives at', a.currentAddress], ['Employment', a.employment],
                    ['Occupants', a.occupants === null ? null : String(a.occupants)],
                    ['Wants to move in', a.moveInDate ? formatDate(a.moveInDate, context.timeZone) : null],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k as string} className="flex gap-2 text-sm">
                      <dt className="shrink-0 text-ink-500">{k}</dt>
                      <dd className="min-w-0 text-ink-900">{v}</dd>
                    </div>
                  ))}
                  {a.monthlyIncomeMinor ? (
                    <div className="flex gap-2 text-sm">
                      <dt className="shrink-0 text-ink-500">Stated income</dt>
                      <dd className="text-ink-900">
                        <Money minor={BigInt(a.monthlyIncomeMinor)} currency={context.currencyCode} />
                        {' '}a month
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {a.message ? (
                  <p className="mt-2 whitespace-pre-line text-sm text-ink-700">{a.message}</p>
                ) : null}

                {a.reviewNote ? (
                  <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
                    <span className="text-ink-500">Decision note: </span>{a.reviewNote}
                  </p>
                ) : null}

                <ApplicationDecision org={org} applicationId={a.id} status={a.status} />
              </Card>
            ))}
          </div>
        )}

        <p className="text-xs text-ink-500">
          Stated income and employment are what the applicant told you. Nothing here has been
          verified, and PropertyOS does not screen or credit-check anyone.
        </p>
      </section>
    </div>
  );
}
