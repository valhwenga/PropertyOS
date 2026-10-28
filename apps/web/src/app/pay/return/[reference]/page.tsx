import Link from 'next/link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { formatMoney, paymentAttemptByReference } from '@propertyos/domain';
import { Wordmark } from '@/components/wordmark';

export const metadata = { title: 'Payment' };
export const dynamic = 'force-dynamic';

/**
 * Where a payer comes back to.
 *
 * The single most important thing about this page is what it will not say. A
 * redirect proves nothing (ADR 0004), so arriving here is not evidence that a
 * payment succeeded, and the page reports the attempt's RECORDED state —
 * which, the instant after a real provider's redirect, is usually still
 * waiting. Saying "thank you, payment received" here is how a product tells a
 * customer their invoice is settled when the money never left.
 *
 * It reads on the privileged connection and by reference only: a payer may not
 * have a session on this device, and the reference is what they hold. It shows
 * an amount and a status and nothing else about the account.
 */
export default async function PaymentReturnPage({
  params, searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ cancelled?: string }>;
}) {
  const { reference } = await params;
  const { cancelled } = await searchParams;

  const sql = privilegedSql();
  const attempt = await sql.begin(async (tx) =>
    paymentAttemptByReference(tx as never, reference));

  const waiting = attempt && (attempt.status === 'created' || attempt.status === 'pending');

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>

      {!attempt ? (
        <PageHeader
          title="We have no record of that payment"
          description="The reference does not match anything. If you have paid, nothing is lost — ring Spike with your bank reference."
        />
      ) : attempt.status === 'confirmed' ? (
        <>
          <PageHeader
            title="Paid, and confirmed"
            description={`${attempt.provider} confirmed ${formatMoney(attempt.amountConfirmedMinor ?? attempt.amountMinor, attempt.currencyCode)} against ${attempt.invoiceNumber}.`}
          />
          <Card className="mt-6 p-5 text-sm text-ink-700">
            <p>
              Your invoice has been updated. This page says confirmed because the provider
              said so out of band, not because you arrived here.
            </p>
          </Card>
        </>
      ) : waiting ? (
        <>
          <PageHeader
            title={cancelled ? 'Nothing was charged' : 'Waiting for confirmation'}
            description={
              cancelled
                ? 'You came back without completing the payment, and nothing has been charged.'
                : 'Your payment provider has not confirmed this yet.'
            }
          />
          <Card className="mt-6 space-y-2 p-5 text-sm text-ink-700">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="info" glyph="◐">{attempt.status}</StatusBadge>
              <span className="tabular text-xs text-ink-500">{attempt.reference}</span>
            </div>
            <p>
              Coming back from a payment page does not prove a payment was made, so this
              product will not mark your invoice paid until the provider confirms the money.
              That usually takes seconds. Refresh this page, or open your subscription
              settings.
            </p>
            <p className="text-ink-500">
              If you believe you have paid and this does not change, send Spike this
              reference rather than paying again.
            </p>
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            title={attempt.status === 'cancelled' ? 'Cancelled' : 'That payment did not go through'}
            description="Nothing was charged."
          />
          <Card className="mt-6 p-5 text-sm text-ink-700">
            <p>
              You can try again from your subscription settings, or pay by transfer quoting
              the invoice number.
            </p>
          </Card>
        </>
      )}

      <p className="mt-6 text-sm">
        <Link href="/app" className="text-spike-600 underline underline-offset-2">
          Back to PropertyOS
        </Link>
      </p>
    </main>
  );
}
