import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Money, StatusBadge } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  loadBalanceSplit, loadPaymentEvidence, loadTenancy,
} from '@/lib/portal-queries';
import { residentPaymentInstructions } from '@propertyos/domain';
import { buildStatement, DomainError } from '@propertyos/domain';
import { CopyField } from './copy-field';
import { RevealAccountNumber } from './reveal-account';
import { Row, SectionHeading } from './section';

export const metadata = { title: 'Your home' };
export const dynamic = 'force-dynamic';

/**
 * What a resident opens the portal to find out: what do I owe, and how do I
 * pay it.
 *
 * The balance is three measures, not one. "Due now" was the whole receivable,
 * which includes a rent invoice raised this morning — money nobody has yet
 * failed to pay. They are separated here, and the word "due" is used only for
 * the part that genuinely is.
 */

/**
 * The stages the database actually records for a piece of payment evidence.
 *
 * `evidence_status` is submitted, under_review, accepted or rejected, with a
 * review timestamp and a note, and a receipt id once one has been raised from
 * it. Nothing here invents a stage or a time the backend does not hold: an
 * accepted claim with no receipt shows "funds confirmed" and stops there,
 * because the allocation has not happened yet.
 */
function evidenceStages(e: {
  status: string; submitted_at: string; reviewed_at: string | null;
  receipt_id: string | null; allocated_minor: string;
}) {
  const decided = e.status === 'accepted' || e.status === 'rejected';
  return [
    { label: 'Proof submitted', at: e.submitted_at, done: true },
    {
      label: 'Under review',
      at: e.status === 'under_review' ? null : decided ? e.reviewed_at : null,
      done: e.status !== 'submitted',
    },
    {
      label: e.status === 'rejected' ? 'Not accepted' : 'Funds confirmed',
      at: decided ? e.reviewed_at : null,
      done: decided,
    },
    {
      label: 'Applied to your account',
      at: null,
      done: Boolean(e.receipt_id) && BigInt(e.allocated_minor) > 0n,
    },
  ];
}

export default async function TenancyHomePage({
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
        balance: await loadBalanceSplit(tx, leaseId),
        statement: await buildStatement(tx, link.organisationId, {
          leaseId, cutOff: new Date().toISOString().slice(0, 10),
        }),
        tenancy: await loadTenancy(tx, leaseId),
        payTo: await residentPaymentInstructions(tx, leaseId),
        evidence: await loadPaymentEvidence(tx, leaseId),
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });
  if (!data?.tenancy) notFound();

  const { balance, statement, tenancy, payTo, evidence } = data;
  const currency = statement.currencyCode;
  const settled = balance.outstandingMinor === 0n;
  // Waiting first, then the three most recent decisions. A resident wants
  // "what is happening to the one I sent" above "what happened in March".
  const pending = evidence.filter((e) => e.status === 'submitted' || e.status === 'under_review');
  const recent = evidence
    .filter((e) => e.status === 'accepted' || e.status === 'rejected')
    .slice(0, 3);
  // `lease_status` is draft, awaiting_execution, active, notice_given,
  // expired, closed or cancelled. An expired lease still carries arrears and
  // can still have a resident in the property, so it is said plainly rather
  // than hidden or treated as settled.
  const closed = ['expired', 'closed', 'cancelled'].includes(tenancy.status);

  return (
    <>
      {/* -------------------------------------------------- what you owe */}
      <Card className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          Outstanding balance
        </p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          <Money minor={balance.outstandingMinor} currency={currency} />
        </p>
        <p className="mt-1.5 text-sm text-ink-500">
          {settled
            ? 'Every charge raised on this lease has been paid. Thank you.'
            : 'Every unpaid charge on your account, whatever its due date.'}
        </p>

        {!settled ? (
          <dl className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-ink-100 p-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Overdue
              </dt>
              <dd className="mt-0.5 text-xl font-semibold text-ink-900">
                <Money minor={balance.overdueMinor} currency={currency} />
              </dd>
              <dd className="mt-0.5 text-xs text-ink-500">
                {balance.overdueMinor > 0n && balance.oldestDueDate
                  ? `Oldest fell due ${formatDate(balance.oldestDueDate)}`
                  : 'Nothing is past its due date'}
              </dd>
            </div>
            <div className="rounded-lg border border-ink-100 p-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Not yet due
              </dt>
              <dd className="mt-0.5 text-xl font-semibold text-ink-900">
                <Money minor={balance.upcomingMinor} currency={currency} />
              </dd>
              <dd className="mt-0.5 text-xs text-ink-500">
                {balance.upcomingMinor > 0n && balance.nextDueDate
                  ? `Due ${formatDate(balance.nextDueDate)}`
                  : 'Nothing is owing in advance'}
              </dd>
            </div>
          </dl>
        ) : null}

        <p className="mt-3 text-xs text-ink-400">
          As at {formatDateTime(balance.asAt, tenancy.time_zone)}.
        </p>

        {closed ? (
          <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
            This lease is {tenancy.status.replace(/_/g, ' ')}. Your statement and documents stay
            here; anything still outstanding is still owed.
          </p>
        ) : null}

        {statement.unappliedCreditMinor > 0n ? (
          <p className="mt-3 rounded-lg bg-positive-50 px-3 py-2 text-sm text-positive-600">
            You have <Money minor={statement.unappliedCreditMinor} currency={currency} /> in
            credit that has not been applied to a charge yet.
          </p>
        ) : null}

        {statement.depositHeldMinor > 0n ? (
          <p className="mt-3 text-sm text-ink-500">
            <span className="font-medium text-ink-700">Deposit recorded as held:</span>{' '}
            <Money minor={statement.depositHeldMinor} currency={currency} />. Your landlord
            records holding this; it is not paid to Spike, and it does not pay your rent or
            reduce the balance above.
          </p>
        ) : null}

        {/* The primary action first in the markup, so it is first under a
            thumb and first for a keyboard. A three-column grid on a wide
            screen keeps the other two equal. */}
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <Link href={`/portal/${leaseId}/payments`}
                className="rounded-lg bg-spike-500 px-4 py-3 text-center text-sm font-medium text-white hover:bg-spike-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500">
            Submit proof of payment
          </Link>
          <Link href={`/portal/${leaseId}/statement`}
                className="rounded-lg border border-ink-200 bg-surface px-4 py-3 text-center text-sm font-medium text-ink-700 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500">
            View statement
          </Link>
          <Link href={`/portal/${leaseId}/requests/new`}
                className="rounded-lg border border-ink-200 bg-surface px-4 py-3 text-center text-sm font-medium text-ink-700 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500">
            Report a problem
          </Link>
        </div>
      </Card>

      {/* ------------------------------------------------ payment evidence */}
      {pending.length > 0 || recent.length > 0 ? (
        <section aria-labelledby="evidence-heading" className="space-y-3">
          <SectionHeading id="evidence-heading">Payments you have told us about</SectionHeading>
          <Card className="divide-y divide-ink-100 p-0">
            {[...pending, ...recent].map((e) => {
              const stages = evidenceStages(e);
              return (
                <div key={e.id} className="px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-900">
                      <Money minor={e.claimed_amount_minor} currency={currency} />
                      <span className="font-normal text-ink-500">
                        {' '}· paid {formatDate(e.claimed_paid_at)}
                      </span>
                    </p>
                    <StatusBadge
                      tone={e.status === 'rejected' ? 'critical'
                        : e.status === 'accepted' ? 'positive' : 'caution'}
                      glyph={e.status === 'rejected' ? '✕'
                        : e.status === 'accepted' ? '✓' : '◐'}
                    >
                      {e.status === 'submitted' ? 'Bank confirmation pending'
                        : e.status === 'under_review' ? 'Under review'
                        : e.status === 'accepted' ? 'Confirmed'
                        : 'Not accepted'}
                    </StatusBadge>
                  </div>

                  <p className="mt-1 text-xs text-ink-500">
                    Submitted {formatDate(e.submitted_at)}
                    {e.reference ? <> · reference <span className="tabular">{e.reference}</span></> : null}
                  </p>

                  {/* The sentence that must not overstate what a document is.
                      An upload is a claim; it establishes nothing about money
                      having arrived. */}
                  {e.status === 'submitted' || e.status === 'under_review' ? (
                    <p className="mt-2 rounded-lg bg-caution-50 px-3 py-2 text-sm text-ink-700">
                      We received your proof of payment for{' '}
                      <Money minor={e.claimed_amount_minor} currency={currency} />. Bank
                      confirmation is pending. Your balance will update once the payment is
                      confirmed and applied to your account.
                    </p>
                  ) : null}

                  {e.status === 'rejected' ? (
                    <div className="mt-2 rounded-lg bg-critical-50 px-3 py-2 text-sm text-ink-700">
                      <p className="font-medium text-critical-700">
                        Your landlord could not match this payment.
                      </p>
                      {e.review_note ? <p className="mt-1">{e.review_note}</p> : null}
                      <p className="mt-2">
                        <Link href={`/portal/${leaseId}/payments`}
                              className="font-medium text-spike-600 hover:underline">
                          Send the details again →
                        </Link>
                      </p>
                    </div>
                  ) : null}

                  <ol className="mt-3 space-y-1.5">
                    {stages.map((stage) => (
                      <li key={stage.label} className="flex items-start gap-2 text-xs">
                        <span
                          aria-hidden="true"
                          className={stage.done ? 'text-positive-600' : 'text-ink-300'}
                        >
                          {stage.done ? '●' : '○'}
                        </span>
                        <span className={stage.done ? 'text-ink-700' : 'text-ink-400'}>
                          {stage.label}
                          {stage.at ? ` · ${formatDate(stage.at)}` : ''}
                          <span className="sr-only">{stage.done ? ' — done' : ' — not yet'}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </Card>
          {pending.length > 0 ? (
            <p className="text-xs text-ink-500">
              Please do not send this one again while it is being checked. If you have made a
              separate payment, tell us about that one too.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ----------------------------------------------------- how to pay */}
      <section aria-labelledby="pay-heading" className="space-y-3">
        <SectionHeading id="pay-heading">How to pay</SectionHeading>
        {payTo ? (
          <Card className="p-0">
            <dl className="divide-y divide-ink-100">
              <Row label="Bank">{payTo.bankName}</Row>
              <Row label="Account name">{payTo.accountHolder}</Row>
              <Row label="Account number">
                <RevealAccountNumber leaseId={leaseId} last4={payTo.accountNumberLast4} />
              </Row>
              {payTo.branchCode ? (
                <Row label="Branch code">
                  <CopyField value={payTo.branchCode} label="branch code" />
                </Row>
              ) : null}
              <Row label="Reference to use">
                <CopyField value={payTo.paymentReference} label="payment reference" />
                <span className="mt-1 block text-xs font-normal text-ink-500">
                  Put this on every payment. Without it, money can sit unmatched instead of
                  clearing your balance.
                </span>
              </Row>
            </dl>
            <div className="border-t border-ink-100 px-4 py-3">
              {/* Said precisely. A person at the landlord confirmed these
                  details by the method recorded; nobody asked a bank. */}
              <p className="text-xs text-ink-500">
                Your landlord confirmed these details
                {payTo.verificationMethod
                  ? ` themselves, by ${payTo.verificationMethod.replace(/_/g, ' ')},`
                  : ' themselves'}
                {' '}on {formatDate(payTo.verifiedAt)}. They have not been checked with the bank
                by Spike.
              </p>
              <p className="mt-2 text-xs font-medium text-ink-700">
                If you are ever told by email or message that the banking details have changed,
                do not pay. Check this page, then phone your landlord on a number you already
                have.
              </p>
            </div>
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
