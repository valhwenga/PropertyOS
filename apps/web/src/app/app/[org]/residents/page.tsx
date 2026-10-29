import Link from 'next/link';
import { DataTable, EmptyState, PageHeader, StatusBadge, Td, Th } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { residentAddressesInTrouble } from '@propertyos/domain';
import { loadResidents } from '@/lib/queries';
import { pageHref, readPaging, summarise } from '@/lib/listing';
import { ListSelect, ListToolbar, PageBar } from '@/components/list-controls';

export const metadata = { title: 'Residents' };
export const dynamic = 'force-dynamic';

/**
 * The statuses a resident profile can carry.
 *
 * Archived is on the list deliberately. It used to be filtered out with no way
 * to ask for it, so an archived person — whose lease history is still there and
 * who somebody eventually has to look up — could not be reached from anywhere
 * in the product.
 */
const STATUSES = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'active', label: 'Active' },
  { value: 'former', label: 'Former' },
  { value: 'archived', label: 'Archived' },
] as const;

export default async function ResidentsPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { org } = await params;
  const query = await searchParams;
  const context = await requireOperator(org);

  const status = STATUSES.some((s) => s.value === query.status) ? query.status : undefined;
  const paging = readPaging(query.page);
  const { rows: residents, total } = await readAs(context.viewer, (tx) =>
    loadResidents(tx, context.organisationId, { query: query.q, status }, paging));

  // Which of these addresses the product can no longer email. A landlord
  // reminding a dead mailbox every month for a year is the thing this is for:
  // they have the person's phone number, and nothing had ever told them to use
  // it. Generalised on purpose — see ADR 0037. An address that belongs to
  // another customer's resident is not in here, and the reason a message was
  // refused is never attributed.
  const trouble = await readAs(context.viewer, (tx) =>
    residentAddressesInTrouble(tx, context.organisationId));
  const introuble = new Map(trouble.map((t) => [t.address.toLowerCase(), t.trouble]));

  const filtered = Boolean(query.q || status);
  const summary = summarise(paging, residents.length, total, filtered);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Residents"
        description="People renting from you. A resident can exist without ever activating a portal account."
        actions={
          <Link href={`/app/${org}/residents/new`} className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
            Add resident
          </Link>
        }
      />

      <ListToolbar
        action={`/app/${org}/residents`}
        query={query.q}
        placeholder="Name, email or phone"
        customised={Object.keys(query).length > 0}
      >
        <ListSelect
          name="status"
          label="Status"
          value={status}
          anyLabel="Everyone except archived"
          options={STATUSES}
        />
      </ListToolbar>

      <PageBar summary={summary} href={(page) => `/app/${org}/residents${pageHref(query, page)}`} />

      {residents.length === 0 ? (
        <EmptyState
          title={filtered ? 'Nobody matches those filters' : 'No residents yet'}
          description={
            filtered
              ? 'Everybody is still here; none of them answers what you asked. Archived people are shown only when you ask for them.'
              : 'Add a resident profile before drafting their lease. Contact details and a portal invitation can follow later.'
          }
        />
      ) : (
        <DataTable
          caption="Resident profiles"
          head={
            <tr>
              <Th>Name</Th><Th>Contact</Th><Th>Identity</Th>
              <Th numeric>Leases</Th><Th>Portal</Th><Th>Status</Th>
            </tr>
          }
        >
          {residents.map((r) => (
            <tr key={r.id} className="hover:bg-ink-50">
              <Td>
                <Link href={`/app/${org}/residents/${r.id}`} className="font-medium text-spike-600 hover:underline">
                  {r.first_name} {r.last_name}
                </Link>
              </Td>
              <Td className="text-ink-500">
                {r.email ?? r.phone ?? '—'}
                {r.email && introuble.has(r.email.toLowerCase()) ? (
                  <span className="mt-0.5 block text-xs font-medium text-caution-700">
                    {introuble.get(r.email.toLowerCase()) === 'asked_not_to_receive'
                      ? 'asked not to receive email — contact them another way'
                      : 'email bounces — contact them another way'}
                  </span>
                ) : null}
              </Td>
              {/* Identity numbers are masked in list views by design. */}
              <Td className="tabular text-ink-400">
                {r.identity_number_last4 ? `••••••• ${r.identity_number_last4}` : '—'}
              </Td>
              <Td numeric className="tabular">{r.lease_count}</Td>
              <Td>
                {r.has_portal
                  ? <StatusBadge tone="positive" glyph="●">Active</StatusBadge>
                  : <StatusBadge tone="neutral" glyph="○">No login</StatusBadge>}
              </Td>
              <Td className="capitalize text-ink-500">{r.status}</Td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
