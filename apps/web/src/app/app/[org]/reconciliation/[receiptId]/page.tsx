import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, EmptyState, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadLeaseChoices, loadReceiptForAllocation } from '@/lib/operations-queries';
import { AllocateForm, IdentifyForm, ReverseForm } from './allocation-forms';

export const metadata = { title: 'Receipt' };
export const dynamic = 'force-dynamic';

/**
 * One receipt, and what to do with it.
 *
 * §9's three steps in the order they happen: the money is recognised (it is
 * already here), whose it is, and what it pays for. A receipt in suspense can
 * only do the second; one on a lease can do the third.
 *
 * The page states the receipt's own figures — received, applied, left — because
 * the gap between "money received" and "money applied" is the thing an operator
 * is actually reconciling, and it is invisible if only one of them is shown.
 */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ org: string; receiptId: string }>;
}) {
  const { org, receiptId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    const detail = await loadReceiptForAllocation(tx, context.organisationId, receiptId);
    if (!detail) return undefined;
    return {
      ...detail,
      // Only needed while the payer is unknown, so not fetched otherwise.
      leases: detail.receipt.in_suspense
        ? await loadLeaseChoices(tx, context.organisationId)
        : [],
    };
  });
  if (!data) notFound();

  const { receipt, openCharges, allocations, leases } = data;
  const today = new Date().toISOString().slice(0, 10);
  const live = allocations.filter((a) => !a.reversed_on);
  const reversed = allocations.filter((a) => a.reversed_on);

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/reconciliation`} className="text-sm text-spike-600 hover:underline">
        ← Reconciliation
      </Link>

      <PageHeader
        title={`Receipt ${receipt.receipt_number}`}
        description={
          `${receipt.method.replace(/_/g, ' ')} received ${formatDate(receipt.received_on, context.timeZone)}`
          + (receipt.payer_reference ? ` · reference "${receipt.payer_reference}"` : '')
        }
      />

      <Card className="p-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Received</dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money minor={BigInt(receipt.amount_minor)} currency={receipt.currency_code} />
            </dd>
            {BigInt(receipt.fee_minor) > 0n ? (
              <dd className="mt-0.5 text-xs text-ink-500">
                Gross. A{' '}
                <Money minor={BigInt(receipt.fee_minor)} currency={receipt.currency_code} />{' '}
                processing fee is recorded separately and does not reduce what the resident paid.
              </dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Applied</dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money minor={BigInt(receipt.allocated_minor)} currency={receipt.currency_code} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Unapplied credit
            </dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money minor={BigInt(receipt.unapplied_minor)} currency={receipt.currency_code} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Lease</dt>
            <dd className="mt-1 text-sm">
              {receipt.lease_id && receipt.lease_reference ? (
                <Link
                  href={`/app/${org}/leases/${receipt.lease_id}`}
                  className="font-medium text-spike-600 hover:underline"
                >
                  {receipt.lease_reference}
                </Link>
              ) : (
                <StatusBadge tone="caution">in suspense</StatusBadge>
              )}
              {receipt.resident_name ? (
                <span className="block text-ink-500">{receipt.resident_name}</span>
              ) : null}
              {receipt.unit_label ? (
                <span className="block text-xs text-ink-400">{receipt.unit_label}</span>
              ) : null}
            </dd>
          </div>
        </dl>
        {receipt.notes ? (
          <p className="mt-4 whitespace-pre-line border-t border-ink-100 pt-4 text-sm text-ink-700">
            {receipt.notes}
          </p>
        ) : null}
      </Card>

      {receipt.status !== 'confirmed' ? (
        <Card className="border-caution-700/30 bg-caution-50 p-4">
          <p className="text-sm text-caution-700">
            This receipt is {receipt.status}. Only confirmed funds can be identified or applied.
          </p>
        </Card>
      ) : receipt.in_suspense ? (
        <IdentifyForm org={org} receiptId={receiptId} leases={leases} today={today} />
      ) : BigInt(receipt.unapplied_minor) === 0n ? (
        <Card className="p-5">
          <p className="text-sm text-ink-700">
            Every cent of this receipt is applied. To change where it went, reverse an allocation
            below and apply it again.
          </p>
        </Card>
      ) : openCharges.length === 0 ? (
        <EmptyState
          title="Nothing open to apply this to"
          description={
            'This lease has no outstanding charges, so the money stays as unapplied credit '
            + 'against it. That is correct: it will absorb the next charge raised, and it is '
            + 'visible on the statement in the meantime.'
          }
        />
      ) : (
        <AllocateForm
          org={org}
          receiptId={receiptId}
          leaseId={receipt.lease_id!}
          unappliedMinor={receipt.unapplied_minor}
          currency={receipt.currency_code}
          today={today}
          charges={openCharges.map((c) => ({
            chargeLineId: c.charge_line_id,
            description: c.description,
            category: c.category,
            dueDate: c.due_date,
            outstandingMinor: c.outstanding_minor,
            dueLabel: formatDate(c.due_date, context.timeZone),
          }))}
        />
      )}

      <Card className="p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          What this receipt has paid
        </h2>
        {allocations.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">
            Nothing applied yet. The money is recorded and sitting as credit.
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-3">
              {live.map((a) => (
                <li key={a.id} className="border-l-2 border-positive-600/40 pl-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-ink-900">{a.description}</span>
                    <span className="tabular font-medium">
                      <Money minor={BigInt(a.amount_minor)} currency={receipt.currency_code} />
                    </span>
                  </div>
                  <p className="text-xs text-ink-400">
                    Applied {formatDate(a.allocated_on, context.timeZone)} ·{' '}
                    {a.applied_policy.replace(/_/g, ' ')} · charge due{' '}
                    {formatDate(a.due_date, context.timeZone)}
                  </p>
                  <ReverseForm org={org} receiptId={receiptId} allocationId={a.id} today={today} />
                </li>
              ))}
            </ul>

            {reversed.length > 0 ? (
              <div className="mt-5 border-t border-ink-100 pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Reversed
                </h3>
                <ul className="mt-2 space-y-2">
                  {reversed.map((a) => (
                    <li key={a.id} className="border-l-2 border-ink-200 pl-3 text-sm text-ink-500">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="line-through">{a.description}</span>
                        <span className="tabular line-through">
                          <Money minor={BigInt(a.amount_minor)} currency={receipt.currency_code} />
                        </span>
                      </div>
                      <p className="text-xs">
                        Reversed {formatDate(a.reversed_on!, context.timeZone)}
                        {a.reversal_reason ? ` — ${a.reversal_reason}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-400">
                  Kept on purpose. A corrected allocation is part of this receipt&rsquo;s history,
                  not something to erase.
                </p>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
