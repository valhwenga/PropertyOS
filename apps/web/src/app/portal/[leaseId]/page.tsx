import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, DataTable, Money, StatusBadge, Td, Th } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { buildStatement, DomainError } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import {
  loadLandlordContact, loadNextDue, loadPaymentDetails, loadResidentRequests,
  loadSharedDocuments,
} from '@/lib/portal-queries';

export const metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

/**
 * A resident's tenancy, in the order they ask about it.
 *
 * What do I owe, how do I pay it, what did you do about the thing I reported,
 * what does my lease say, and where are my documents. The page used to answer
 * the first and the fourth; the second had no answer anywhere in the product,
 * and the third could be asked and never followed up.
 *
 * One column throughout. Most residents open this on a phone, standing up,
 * and the measure of this page is whether the first screenful answers the
 * question they opened it with.
 */

const REQUEST_STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  submitted:             { tone: 'caution',  glyph: '◐', label: 'Received' },
  triaged:               { tone: 'caution',  glyph: '◐', label: 'Being assessed' },
  awaiting_approval:     { tone: 'caution',  glyph: '◐', label: 'Awaiting approval' },
  assigned:              { tone: 'info',     glyph: '◆', label: 'Contractor assigned' },
  in_progress:           { tone: 'info',     glyph: '◆', label: 'Work in progress' },
  awaiting_confirmation: { tone: 'info',     glyph: '◆', label: 'Waiting on you' },
  resolved:              { tone: 'positive', glyph: '✓', label: 'Resolved' },
  closed:                { tone: 'neutral',  glyph: '■', label: 'Closed' },
  cancelled:             { tone: 'neutral',  glyph: '✕', label: 'Cancelled' },
};

function SectionHeading({ id, children, action }: {
  id: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="text-sm font-semibold uppercase tracking-wide text-ink-500">
        {children}
      </h2>
      {action}
    </div>
  );
}

export default async function ResidentLeasePage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();

  // The resident's reachable leases come from their own portal links. Changing
  // the id in the URL to another lease simply does not resolve.
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) notFound();

  const data = await readAs(viewer, async (tx) => {
    const [lease] = await tx<
      { reference: string; unit_label: string; status: string; start_date: string;
        end_date: string | null; notice_days: number | null; rent_minor: string;
        currency_code: string; renewal_option_months: number | null;
        renewal_notice_months: number | null }[]
    >`
      select l.reference, l.status::text, l.start_date::text, l.end_date::text,
             l.notice_days, l.rent_minor::text, l.currency_code,
             t.renewal_option_months, t.renewal_notice_months,
             p.name || ' / ' || u.code as unit_label
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_agreement_terms t on t.lease_id = l.id
      where l.id = ${leaseId}::uuid
    `;
    if (!lease) return null;

    try {
      const statement = await buildStatement(tx, link.organisationId, {
        leaseId,
        cutOff: new Date().toISOString().slice(0, 10),
      });
      return {
        lease,
        statement,
        documents: await loadSharedDocuments(tx, leaseId),
        payTo: await loadPaymentDetails(tx, leaseId),
        contact: await loadLandlordContact(tx, leaseId),
        requests: await loadResidentRequests(tx, leaseId),
        nextDue: await loadNextDue(tx, leaseId),
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });

  if (!data) notFound();
  const { lease, documents, statement, payTo, contact, requests, nextDue } = data;
  const owing = statement.closingReceivableMinor > 0n;
  const pending = statement.pendingEvidence.reduce((s, e) => s + e.claimedAmountMinor, 0n);
  const open = requests.filter((r) => !['resolved', 'closed', 'cancelled'].includes(r.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{lease.unit_label}</h1>
        <p className="text-sm text-ink-500">Lease {lease.reference}</p>
      </div>

      {/* ------------------------------------------------------- what you owe */}
      <Card className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {owing ? 'Due now' : 'Your balance'}
        </p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          <Money minor={statement.closingReceivableMinor} currency={statement.currencyCode} />
        </p>
        <p className="mt-2 text-sm text-ink-500">
          {owing
            ? 'Charges that have been raised, less the payments already applied to them.'
            : 'Nothing is outstanding. Thank you.'}
        </p>

        {/* What is coming, kept apart from what is owed. Adding them together
            would invent arrears out of a rent invoice that is not due yet. */}
        {nextDue ? (
          <p className="mt-3 text-sm text-ink-700">
            Next: <Money minor={nextDue.amount_minor} currency={nextDue.currency_code} /> due{' '}
            {formatDate(nextDue.due_date)}.
          </p>
        ) : null}

        {/* Sits with the balance it does not change. A resident who uploaded a
            payment yesterday opens this page to ask "did you get it?", and the
            answer belongs next to the figure, not three sections down. */}
        {pending > 0n ? (
          <div className="mt-4 rounded-lg border border-caution-700/25 bg-caution-50 p-3">
            <StatusBadge tone="caution" glyph="◐">Awaiting verification</StatusBadge>
            <p className="mt-2 text-sm text-ink-700">
              We have your payment of <Money minor={pending} currency={statement.currencyCode} />,
              and we are checking it against the bank record. The balance above has not
              changed yet and will not until the money is confirmed.
            </p>
          </div>
        ) : null}

        {statement.unappliedCreditMinor > 0n ? (
          <p className="mt-3 rounded-lg bg-positive-50 px-3 py-2 text-sm text-positive-600">
            You have <Money minor={statement.unappliedCreditMinor} currency={statement.currencyCode} />{' '}
            in credit that has not been applied to a charge yet.
          </p>
        ) : null}

        {statement.depositHeldMinor > 0n ? (
          <p className="mt-3 text-sm text-ink-500">
            Deposit held:{' '}
            <Money minor={statement.depositHeldMinor} currency={statement.currencyCode} />. This is
            yours, held separately, and it does not reduce the balance above.
          </p>
        ) : null}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Link href={`/portal/${leaseId}/payments`}
                className="rounded-lg bg-spike-500 px-4 py-3 text-center text-sm font-medium text-white">
            I have paid — tell my landlord
          </Link>
          <Link href={`/portal/${leaseId}/maintenance/new`}
                className="rounded-lg border border-ink-200 bg-surface px-4 py-3 text-center text-sm font-medium text-ink-700">
            Report a problem
          </Link>
        </div>
      </Card>

      {/* ---------------------------------------------------------- how to pay */}
      <section aria-labelledby="pay-heading" className="space-y-3">
        <SectionHeading id="pay-heading">How to pay</SectionHeading>
        {payTo ? (
          <Card className="p-0">
            <dl className="divide-y divide-ink-100">
              <Row label="Bank">{payTo.bank_name}</Row>
              <Row label="Account name">{payTo.account_holder}</Row>
              <Row label="Account number">
                <span className="tabular">•••• {payTo.account_number_last4}</span>
                <span className="mt-0.5 block text-xs font-normal text-ink-500">
                  Only the last four digits are shown. Use the full number your landlord gave
                  you, and check it ends in these four before you pay.
                </span>
              </Row>
              {payTo.branch_code ? (
                <Row label="Branch code"><span className="tabular">{payTo.branch_code}</span></Row>
              ) : null}
              <Row label="Reference to use">
                <span className="tabular">{payTo.payment_reference}</span>
                <span className="mt-0.5 block text-xs font-normal text-ink-500">
                  Put this on every payment. Without it, money can sit unmatched instead of
                  clearing your balance.
                </span>
              </Row>
            </dl>
            <p className="border-t border-ink-100 px-4 py-3 text-xs text-ink-500">
              Your landlord confirmed these details
              {payTo.verification_method ? ` by ${payTo.verification_method.replace(/_/g, ' ')}` : ''}
              {' '}on {formatDate(payTo.verified_at)}.{' '}
              <strong className="font-medium text-ink-700">
                If you are ever told by email or message that the banking details have changed,
                do not pay. Check this page, then phone your landlord on a number you already
                have.
              </strong>
            </p>
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-sm text-ink-700">
              Your landlord has not confirmed banking details here yet. Use the details on your
              signed lease, and ask them to confirm before you pay anything to details you were
              sent rather than given.
            </p>
          </Card>
        )}
      </section>

      {/* --------------------------------------------------------- your requests */}
      <section aria-labelledby="requests-heading" className="space-y-3">
        <SectionHeading
          id="requests-heading"
          action={
            <Link href={`/portal/${leaseId}/maintenance/new`}
                  className="text-sm font-medium text-spike-600 hover:underline">
              Report a problem
            </Link>
          }
        >
          Your requests{open.length > 0 ? ` (${open.length} open)` : ''}
        </SectionHeading>
        {requests.length === 0 ? (
          <Card className="px-4 py-6 text-center text-sm text-ink-500">
            Nothing reported. If something in the property needs fixing, tell your landlord here
            so there is a record of when you reported it.
          </Card>
        ) : (
          <Card className="divide-y divide-ink-100 p-0">
            {requests.map((request) => {
              const status = REQUEST_STATUS[request.status]
                ?? { tone: 'neutral' as StatusTone, glyph: '○', label: request.status };
              return (
                <div key={request.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium text-ink-900">{request.description}</p>
                    <StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    <span className="tabular">{request.reference}</span> · reported{' '}
                    {formatDate(request.created_at)}
                  </p>
                  {request.last_update ? (
                    <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
                      {request.last_update}
                      <span className="mt-0.5 block text-xs text-ink-400">
                        {request.last_update_at ? formatDate(request.last_update_at) : null}
                      </span>
                    </p>
                  ) : null}
                </div>
              );
            })}
          </Card>
        )}
        <p className="text-xs text-ink-500">
          A request logged here is not an emergency service. If somebody is in danger, or water
          or electricity is causing damage right now, phone
          {contact?.phone ? ` ${contact.phone}` : ' your landlord'} as well.
        </p>
      </section>

      {/* ------------------------------------------------------------ statement */}
      <section aria-labelledby="statement-heading" className="space-y-3">
        <SectionHeading
          id="statement-heading"
          action={
            <a
              href={`/portal/${leaseId}/statement.pdf`}
              className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm font-medium text-ink-700"
            >
              Download PDF
            </a>
          }
        >
          Statement
        </SectionHeading>
        {/* A phone first.
            `DataTable` is 640px wide at minimum and scrolls sideways inside
            its own box, which is right for an operator with a wide screen and
            wrong here: the two columns that matter — what it cost and what the
            balance became — were the two off the right-hand edge. Below `sm`
            the same lines are a list; from `sm` up, the table returns. */}
        <Card className="divide-y divide-ink-100 p-0 sm:hidden">
          {statement.lines.map((line, index) => (
            <div key={`m-${line.reference}-${index}`} className="flex gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-900">{line.description}</p>
                <p className="text-xs text-ink-400">
                  {formatDate(line.entryDate)} · <span className="tabular">{line.reference}</span>
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium">
                  {line.debitMinor > 0n ? (
                    <Money minor={line.debitMinor} currency={statement.currencyCode} />
                  ) : (
                    <span className="text-positive-600">
                      −<Money minor={line.creditMinor} currency={statement.currencyCode} />
                    </span>
                  )}
                </p>
                <p className="text-xs text-ink-400">
                  balance{' '}
                  <Money minor={line.runningBalanceMinor} currency={statement.currencyCode} />
                </p>
              </div>
            </div>
          ))}
        </Card>

        <div className="hidden sm:block">
        <DataTable
          caption={`Statement for lease ${lease.reference}`}
          dense
          head={
            <tr><Th>Date</Th><Th>Description</Th><Th numeric>Amount</Th><Th numeric>Balance</Th></tr>
          }
        >
          {statement.lines.map((line, index) => (
            <tr key={`${line.reference}-${index}`}>
              <Td className="whitespace-nowrap text-ink-500">{formatDate(line.entryDate)}</Td>
              <Td>
                <span className="block">{line.description}</span>
                <span className="tabular text-xs text-ink-400">{line.reference}</span>
              </Td>
              <Td numeric>
                {line.debitMinor > 0n ? (
                  <Money minor={line.debitMinor} currency={statement.currencyCode} />
                ) : (
                  <span className="text-positive-600">
                    −<Money minor={line.creditMinor} currency={statement.currencyCode} />
                  </span>
                )}
              </Td>
              <Td numeric>
                <Money minor={line.runningBalanceMinor} currency={statement.currencyCode} />
              </Td>
            </tr>
          ))}
        </DataTable>
        </div>
      </section>

      {/* ----------------------------------------------------------- your lease */}
      <section aria-labelledby="lease-heading" className="space-y-3">
        <SectionHeading id="lease-heading">Your lease</SectionHeading>
        <Card className="p-0">
          <dl className="divide-y divide-ink-100">
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
        <p className="text-xs text-ink-500">
          These are the terms recorded on your lease. The signed agreement is the authority; if
          something here looks wrong, tell your landlord.
        </p>
      </section>

      {/* --------------------------------------------------------- your documents */}
      <section aria-labelledby="documents-heading" className="space-y-3">
        <SectionHeading id="documents-heading">Your documents</SectionHeading>
        {documents.length === 0 ? (
          <Card className="px-4 py-6 text-center text-sm text-ink-500">
            No documents have been shared with you yet.
          </Card>
        ) : (
          <Card className="divide-y divide-ink-100 p-0">
            {documents.map((doc) => (
              <a key={doc.id} href={`/portal/${leaseId}/documents/${doc.id}`}
                 className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{doc.title}</p>
                  <p className="text-xs capitalize text-ink-500">
                    {doc.classification.replace(/_/g, ' ')} · {formatDate(doc.uploaded_at)}
                  </p>
                </div>
                <span aria-hidden="true" className="text-spike-500">↓</span>
              </a>
            ))}
          </Card>
        )}
      </section>

      {/* ------------------------------------------------------------- who to ask */}
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
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-sm font-medium text-ink-900">{children}</dd>
    </div>
  );
}
