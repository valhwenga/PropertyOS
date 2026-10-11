import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge } from '@propertyos/ui';
import {
  auditFacets, auditHistoryFor, changedFields, listAuditEvents, type AuditEntry,
} from '@propertyos/domain';
import { DomainError } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'Audit trail' };
export const dynamic = 'force-dynamic';

/**
 * The audit trail, read back.
 *
 * Every command writes an entry in the same transaction as the change it
 * describes, and until now nothing could read one: the trail existed for a
 * dispute nobody could open.
 *
 * The page is built around one sentence it has to earn — "nothing here can be
 * changed" — and around saying what each entry MEANS rather than printing two
 * JSON blobs and leaving the reader to diff them.
 */

/** How a field name reads to somebody who did not write the code. */
function humanise(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** A stored value, as something a person can read. */
function show(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'nothing';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function Entry({ entry, timeZone }: { entry: AuditEntry; timeZone: string }) {
  const changes = changedFields(entry);
  const creation = entry.before === null && entry.after !== null;

  return (
    <li className="border-t border-ink-100 px-4 py-4 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-ink-900">{entry.action}</p>
        <p className="text-xs text-ink-500">
          {formatDateTime(entry.occurredAt, timeZone)}
        </p>
      </div>

      <p className="mt-0.5 text-xs text-ink-500">
        {entry.actorName ?? entry.actorEmail ?? 'the system'}
        {entry.actorRole ? ` · ${entry.actorRole}` : ''}
        {' · '}{entry.resourceType}
        {entry.supportSessionId ? (
          <span className="ml-1.5 align-middle">
            <StatusBadge tone="caution" glyph="◐">during Spike support access</StatusBadge>
          </span>
        ) : null}
      </p>

      {entry.reason ? (
        <p className="mt-2 text-sm text-ink-700">
          <span className="font-medium">Reason given:</span> {entry.reason}
        </p>
      ) : null}

      {changes.length > 0 ? (
        <dl className="mt-2 space-y-1">
          {changes.map((change) => (
            <div key={change.field} className="flex flex-wrap gap-x-2 text-sm">
              <dt className="text-ink-500">{humanise(change.field)}</dt>
              <dd className="text-ink-900">
                {change.redacted ? (
                  // Not "we are hiding this from you": it was replaced before
                  // it was written, so it was never here to show.
                  <span className="text-ink-500">
                    held back — a value of this kind is never written to the trail
                  </span>
                ) : creation ? (
                  show(change.to)
                ) : (
                  <>
                    <span className="text-ink-500 line-through">{show(change.from)}</span>
                    {' → '}
                    <span>{show(change.to)}</span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

export default async function AuditPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{
    action?: string; resourceType?: string; resourceId?: string; actor?: string;
    from?: string; to?: string; before?: string; label?: string;
  }>;
}) {
  const { org } = await params;
  const query = await searchParams;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    try {
      // One record's own history is the question an operator actually arrives
      // with — "what happened to this property" — so it is a different read,
      // not a filter bolted onto the organisation-wide one.
      if (query.resourceType && query.resourceId) {
        return {
          page: {
            entries: await auditHistoryFor(tx, context.organisationId, {
              resourceType: query.resourceType, resourceId: query.resourceId,
            }),
            hasMore: false,
            nextCursor: null,
          },
          facets: await auditFacets(tx, context.organisationId),
          refusal: null as string | null,
        };
      }
      return {
        page: await listAuditEvents(tx, context.organisationId, {
          action: query.action || undefined,
          resourceType: query.resourceType || undefined,
          actorUserId: query.actor || undefined,
          from: query.from || undefined,
          to: query.to || undefined,
          before: query.before || undefined,
          limit: 50,
        }),
        facets: await auditFacets(tx, context.organisationId),
        refusal: null as string | null,
      };
    } catch (error) {
      // A refusal here is information, not a crash: it says either "you may
      // not" or "this cannot be answered for you honestly", and the reader
      // needs to know which.
      if (error instanceof DomainError
          && (error.code === 'forbidden' || error.code === 'validation_failed')) {
        return { page: null, facets: null, refusal: error.message };
      }
      throw error;
    }
  });

  const { page, facets, refusal } = data;
  const oneRecord = Boolean(query.resourceType && query.resourceId);
  const filtered = Boolean(
    query.action || query.resourceType || query.actor || query.from || query.to,
  );

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/settings`} className="text-sm text-spike-600 hover:underline">
        ← Settings
      </Link>

      <PageHeader
        title="Audit trail"
        description="Every change anybody made to this organisation's records: who, when, what it was before, and the reason they gave."
      />

      {refusal ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">{refusal}</p>
        </Card>
      ) : null}

      {oneRecord ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            Every change to{' '}
            <strong>{query.label ? query.label : `this ${query.resourceType}`}</strong>, newest
            first. This is one record&rsquo;s own history, not a filtered view of the whole
            trail.
          </p>
          <Link
            href={`/app/${org}/settings/audit`}
            className="mt-2 inline-block text-sm text-spike-600 hover:underline"
          >
            Show the whole trail →
          </Link>
        </Card>
      ) : null}

      {page && facets ? (
        <>
          <Card className="p-4">
            <p className="text-sm text-ink-700">
              Nothing on this page can be changed. Audit entries are written in the same
              transaction as the change they describe, so an action cannot be committed without
              one, and the right to update or delete them is not granted to the application at
              all — not to an administrator, and not to Spike support.
            </p>
          </Card>

          {/* A plain GET form: a filter that needs JavaScript is a filter that
              cannot be bookmarked or sent to somebody else. Hidden while
              reading one record, because applying a filter there would quietly
              switch the reader to a different question. */}
          {oneRecord ? null : (
          <Card className="p-4">
            <form method="get" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1.5">
                <label htmlFor="action" className="block text-sm font-medium text-ink-700">
                  Action
                </label>
                <select
                  id="action" name="action" defaultValue={query.action ?? ''}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                >
                  <option value="">Everything</option>
                  {facets.actions.map((a) => (
                    <option key={a.action} value={a.action}>
                      {a.action} ({a.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="resourceType" className="block text-sm font-medium text-ink-700">
                  Kind of record
                </label>
                <select
                  id="resourceType" name="resourceType" defaultValue={query.resourceType ?? ''}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                >
                  <option value="">Everything</option>
                  {facets.resourceTypes.map((r) => (
                    <option key={r.resourceType} value={r.resourceType}>
                      {r.resourceType} ({r.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="actor" className="block text-sm font-medium text-ink-700">
                  Who
                </label>
                <select
                  id="actor" name="actor" defaultValue={query.actor ?? ''}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                >
                  <option value="">Anybody</option>
                  {facets.actors.map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {a.name ?? 'Unnamed'} ({a.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="from" className="block text-sm font-medium text-ink-700">
                  From
                </label>
                <input
                  id="from" name="from" type="date" defaultValue={query.from ?? ''}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="to" className="block text-sm font-medium text-ink-700">
                  To
                </label>
                <input
                  id="to" name="to" type="date" defaultValue={query.to ?? ''}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
                />
                <p className="text-xs text-ink-500">The whole of this day is included.</p>
              </div>

              <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
                <button
                  type="submit"
                  className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-spike-600"
                >
                  Apply
                </button>
                {filtered ? (
                  <Link
                    href={`/app/${org}/settings/audit`}
                    className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700"
                  >
                    Clear
                  </Link>
                ) : null}
              </div>
            </form>
          </Card>
          )}

          {page.entries.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              description={filtered
                ? 'No change matches those filters. The trail itself is not empty — clear them to see it.'
                : 'No changes have been recorded for this organisation yet.'}
            />
          ) : (
            <Card>
              <ul>
                {page.entries.map((entry) => (
                  <Entry key={entry.id} entry={entry} timeZone={context.timeZone} />
                ))}
              </ul>
            </Card>
          )}

          {page.hasMore && page.nextCursor ? (
            <Link
              href={{
                pathname: `/app/${org}/settings/audit`,
                query: { ...query, before: page.nextCursor },
              }}
              className="inline-block rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700"
            >
              Older changes →
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
