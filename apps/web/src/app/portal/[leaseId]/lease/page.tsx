import { notFound } from 'next/navigation';
import { Card, Money } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadLandlordContact, loadSharedDocuments, loadTenancy } from '@/lib/portal-queries';
import { Row, SectionHeading } from '../section';

export const metadata = { title: 'Lease details' };
export const dynamic = 'force-dynamic';

/**
 * The terms, and who to ask about them.
 *
 * A tenant asking "when does this end?" or "how much notice do I give?" should
 * not have to ask a person for something the system already knows, and the
 * contact details are the ones on the lease they signed — reunited with them
 * at the moment they need them rather than at the bottom of a drawer.
 */
export default async function LeasePage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const { lease, contact, documents } = await readAs(viewer, async (tx) => ({
    lease: await loadTenancy(tx, leaseId),
    contact: await loadLandlordContact(tx, leaseId),
    documents: await loadSharedDocuments(tx, leaseId),
  }));
  if (!lease) notFound();

  // The signed agreement, if the landlord has shared one. It is the authority
  // for everything above it, so it belongs on this page and not only in the
  // documents list.
  const agreement = documents.find((d) => d.classification === 'lease') ?? null;

  return (
    <>
      <section aria-labelledby="lease-heading" className="space-y-3">
        <SectionHeading id="lease-heading">Lease details</SectionHeading>
        <Card className="p-0">
          <dl className="divide-y divide-ink-100">
            <Row label="Home">{lease.unit_label}</Row>
            <Row label="Lease reference"><span className="tabular">{lease.reference}</span></Row>
            <Row label="Rent">
              <Money minor={BigInt(lease.rent_minor)} currency={lease.currency_code} /> a month
            </Row>
            <Row label="Started">{formatDate(lease.start_date)}</Row>
            <Row label="Ends">
              {lease.end_date ? formatDate(lease.end_date) : 'No end date recorded'}
            </Row>
            <Row label="Notice to end the lease">
              {lease.notice_days === null
                ? 'Not recorded — ask your landlord'
                : `${lease.notice_days} days`}
            </Row>
            {lease.renewal_option_months ? (
              <Row label="Renewal">
                You may renew for a further {lease.renewal_option_months} months
                {lease.renewal_notice_months
                  ? `, by telling your landlord in writing at least ${lease.renewal_notice_months} months before the end date`
                  : ''}
                .
              </Row>
            ) : null}
          </dl>
        </Card>
        {agreement ? (
          <a
            href={`/portal/${leaseId}/documents/${agreement.id}`}
            className="flex min-h-11 items-center justify-between gap-3 rounded-[var(--radius-card)] border border-ink-100 bg-surface px-4 py-3 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink-900">
                {agreement.title}
              </span>
              <span className="block text-xs text-ink-500">
                Your signed agreement · {formatDate(agreement.uploaded_at)}
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-spike-500">↓</span>
          </a>
        ) : null}

        <p className="text-xs text-ink-500">
          These are the terms recorded on your lease. The signed agreement is the authority; if
          something here looks wrong, tell your landlord.
        </p>
      </section>

      {contact ? (
        <section aria-labelledby="contact-heading" className="space-y-3">
          <SectionHeading id="contact-heading">Who to contact</SectionHeading>
          <Card className="p-0">
            <dl className="divide-y divide-ink-100">
              <Row label="Landlord">{contact.trading_name}</Row>
              {contact.phone ? (
                <Row label="Phone">
                  <a href={`tel:${contact.phone}`} className="text-spike-600 hover:underline">
                    {contact.phone}
                  </a>
                </Row>
              ) : null}
              {contact.email ? (
                <Row label="Email">
                  <a href={`mailto:${contact.email}`} className="break-all text-spike-600 hover:underline">
                    {contact.email}
                  </a>
                </Row>
              ) : null}
              {contact.agent_name ? (
                <Row label="Managing agent">
                  {contact.agent_name}
                  {contact.agent_contact ? (
                    <span className="mt-0.5 block text-xs font-normal text-ink-500">
                      {contact.agent_contact}
                    </span>
                  ) : null}
                </Row>
              ) : null}
            </dl>
          </Card>
        </section>
      ) : null}
    </>
  );
}
