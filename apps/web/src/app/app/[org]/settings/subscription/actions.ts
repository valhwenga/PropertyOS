'use server';

import { redirect } from 'next/navigation';
import { startPayment } from '@propertyos/domain';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { command } from '@/lib/actions';
import { log } from '@/lib/logger';

/**
 * Paying an invoice, from the customer's side.
 *
 * Two steps that must not be one. The attempt is created inside the command's
 * transaction, so it is committed before the payer leaves; then the provider is
 * asked where to send them. A checkout URL built before the attempt exists
 * would be a reference the notification endpoint has never heard of, and a
 * provider confirming a payment we have no record of asking for is the worst
 * of the failure modes.
 *
 * `markPaymentPending` is deliberately NOT called here. Leaving for the payment
 * page is not a state worth recording from the side that cannot observe
 * whether they arrived; the provider's own first notification says it better.
 */
export async function payInvoiceAction(_previous: unknown, formData: FormData) {
  const invoiceId = String(formData.get('invoiceId') ?? '');
  const provider = resolvePaymentProvider();

  if (!provider.available) {
    return {
      ok: false as const,
      message: `Paying online is not available: ${provider.unavailableReason}`,
    };
  }

  const started = await command(({ tx, viewer }) =>
    startPayment(tx, viewer.authUserId, { invoiceId, provider: provider.name }));
  if (!started.ok) return started;

  const { reference, amountMinor, currencyCode } =
    started as unknown as { reference: string; amountMinor: number; currencyCode: string };

  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  let checkout;
  try {
    checkout = await provider.checkout({
      reference,
      amountMinor,
      currencyCode,
      description: `PropertyOS subscription — ${reference}`,
      returnUrl: `${base}/pay/return/${reference}`,
      cancelUrl: `${base}/pay/return/${reference}?cancelled=1`,
      notifyUrl: `${base}/api/payments/${provider.name}/notify`,
    });
  } catch (error) {
    log('error', 'checkout could not be created', {
      provider: provider.name,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return {
      ok: false as const,
      message: 'The payment page could not be opened. Nothing has been charged. '
        + 'Pay by transfer, or try again.',
    };
  }

  if (checkout.method === 'GET') {
    // Outside the try: `redirect` works by throwing, and catching it here
    // would turn a successful hand-off into an error message.
    redirect(checkout.url);
  }

  // A provider that wants a form POST: the page renders and submits it.
  return { ok: true as const, url: checkout.url, fields: checkout.fields };
}
