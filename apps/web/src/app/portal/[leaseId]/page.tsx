import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Money, StatusBadge } from '@propertyos/ui';
import { buildStatement, DomainError } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadNextDue, loadPaymentDetails } from '@/lib/portal-queries';
import { Row, SectionHeading } from './section';

export const metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

/**
 * What a resident opens the portal to find out: what do I owe, and how do I
 * pay it.
 *
 * Everything else — the statement behind the figure, the requests, the
 * documents, the lease terms — is a section of its own now. This page answers
 * the first question in its first screenful and the second immediately below,
 * because a portal that asks somebody to pay and does not say where is half a
 * feature.
 */
export default async function TenancyOverviewPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) notFound();

  const data = await readAs(viewer, async (tx) => {
    try {
      return {
        statement: await buildStatement(tx, link.organisationId, {
          leaseId, cutOff: new Date().toISOString().slice(0, 10),
        }),
        payTo: await loadPaymentDetails(tx, leaseId),
        nextDue: await loadNextDue(tx, leaseId),
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });
  if (!data) notFound();

  const { statement, payTo, nextDue } = data;
  const owing = statement.closingReceivableMinor > 0n;
  const pending = statement.pendingEvidence.reduce((s, e) => s + e.claimedAmountMinor, 0n);

  return (
    <>
      {/* ----------------------------------------------------- what you owe */}
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
            answer belongs next to the figure, not in another section. */}
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
          <Link href={`/portal/${leaseId}/requests/new`}
                className="rounded-lg border border-ink-200 bg-surface px-4 py-3 text-center text-sm font-medium text-ink-700">
            Report a problem
          </Link>
        </div>

        <p className="mt-4 text-sm">
          <Link href={`/portal/${leaseId}/statement`} className="text-spike-600 hover:underline">
            See every charge and payment →
          </Link>
        </p>
      </Card>

      {/* -------------------------------------------------------- how to pay */}
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
    </>
  );
}
