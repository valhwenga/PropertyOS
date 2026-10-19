import Link from 'next/link';
import {
  DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th, buttonClass,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadLeases } from '@/lib/queries';
import { pageHref, readPaging, summarise } from '@/lib/listing';
import { ListSelect, ListToolbar, PageBar } from '@/components/list-controls';

export const metadata = { title: 'Leases' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  draft:              { tone: 'neutral',  glyph: '○', label: 'Draft' },
  awaiting_execution: { tone: 'caution',  glyph: '◐', label: 'Awaiting execution' },
  active:             { tone: 'positive', glyph: '●', label: 'Active' },
  notice_given:       { tone: 'caution',  glyph: '◐', label: 'Notice given' },
  expired:            { tone: 'critical', glyph: '▲', label: 'Expired' },
  closed:             { tone: 'neutral',  glyph: '■', label: 'Closed' },
  cancelled:          { tone: 'neutral',  glyph: '✕', label: 'Cancelled' },
};

export default async function LeasesPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ expiring?: string; q?: string; status?: string; page?: string }>;
}) {
  const { org } = await params;
  const query = await searchParams;
  const context = await requireOperator(org);

  // The dashboard "expiring leases" tile links here with the same filter, so
  // the horizon stays a number of days rather than becoming a status.
  const expiringWithinDays = query.expiring !== undefined && Number.isFinite(Number(query.expiring))
    ? Math.max(0, Number(query.expiring))
    : undefined;
  const status = STATUS[query.status ?? ''] ? query.status : undefined;
  const paging = readPaging(query.page);

  const { rows: leases, total } = await readAs(context.viewer, (tx) =>
    loadLeases(tx, context.organisationId,
      { query: query.q, status, expiringWithinDays }, paging));

  const filtered = Boolean(query.q || status || expiringWithinDays !== undefined);
  const summary = summarise(paging, leases.length, total, filtered);
  const expiring = query.expiring;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leases"
        description={
          expiring
            ? `Active leases expiring within ${expiring} days.`
            : 'Lease status is tracked separately from physical occupancy. An expired lease can still carry arrears.'
        }
        actions={
          <Link href={`/app/${org}/leases/new`} className={buttonClass('primary')}>
            Draft lease
          </Link>
        }
        toolbar={
          <ListToolbar
            action={`/app/${org}/leases`}
            query={query.q}
            placeholder="Reference, resident or unit"
            customised={Object.keys(query).length > 0}
            // Only when something is actually applied: "Every status" under an
            // untouched toolbar is a line that says nothing.
            scope={filtered ? [
              status ? `Status: ${STATUS[status]!.label}` : 'Every status',
              expiringWithinDays !== undefined ? `Ending within ${expiringWithinDays} days` : null,
              query.q ? `Matching “${query.q}”` : null,
            ].filter(Boolean).join(' · ') : undefined}
          >
            {/* Carried through the form, or searching inside "expiring in 60
                days" would quietly widen the list back to every lease. */}
            {expiring !== undefined ? (
              <input type="hidden" name="expiring" value={expiring} />
            ) : null}
            <ListSelect
              name="status"
              label="Status"
              value={status}
              anyLabel="Any status"
              options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))}
            />
          </ListToolbar>
        }
      />

      <PageBar summary={summary} href={(page) => `/app/${org}/leases${pageHref(query, page)}`} />

      {leases.length === 0 ? (
        <EmptyState
          title={filtered ? 'Nothing matches those filters' : 'No leases yet'}
          description={
            filtered
              ? 'Every lease is still here; none of them answers what you asked. Reset the filters to see them all.'
              : 'Draft a lease once you have a unit and a resident. A draft has no billing effect until it is activated.'
          }
        />
      ) : (
        <DataTable
          caption="Leases"
          stickyHead
          minWidth="52rem"
          head={
            <tr>
              <Th>Resident</Th><Th>Unit</Th><Th>Reference</Th><Th>Term</Th>
              <Th numeric>Rent</Th><Th numeric>Receivable</Th><Th>Status</Th>
            </tr>
          }
        >
          {leases.map((l) => {
            const status = STATUS[l.status] ?? { tone: 'neutral' as StatusTone, glyph: '○', label: l.status };
            return (
              <tr key={l.id}>
                {/* The person first: a reference identifies the record, but
                    nobody scans this list looking for one. */}
                <Td>
                  <Link
                    href={`/app/${org}/leases/${l.id}`}
                    className="font-medium text-spike-600 hover:underline"
                  >
                    {l.resident_name}
                  </Link>
                </Td>
                <Td className="text-ink-700">{l.unit_label}</Td>
                {/* The reference is quiet, but it is still a way in: somebody
                    who has it — from an import, a statement, a bank line —
                    arrives looking for exactly that row. */}
                <Td className="whitespace-nowrap">
                  <Link
                    href={`/app/${org}/leases/${l.id}`}
                    className="technical text-ink-500 hover:text-spike-600 hover:underline"
                  >
                    {l.reference}
                  </Link>
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDate(l.start_date, context.timeZone)} –{' '}
                  {l.end_date ? formatDate(l.end_date, context.timeZone) : 'open ended'}
                </Td>
                <Td numeric><Money minor={l.rent_minor} currency={l.currency_code} tone="plain" /></Td>
                <Td numeric>
                  <Money minor={l.receivable_minor} currency={l.currency_code} tone="debt"
                         emphasise={BigInt(l.receivable_minor) > 0n} />
                </Td>
                <Td>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}
