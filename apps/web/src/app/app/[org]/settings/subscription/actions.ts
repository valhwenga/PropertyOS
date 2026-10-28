'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  cancelMandate, parseMajorToMinor, requestMandate, startPayment,
} from '@propertyos/domain';
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

/**
 * Asking the payer's bank to authorise a standing collection.
 *
 * Two steps, like starting a payment and for the same reason: the mandate row
 * is committed before the payer leaves, so the reference the provider echoes
 * back is one this product has heard of.
 *
 * What it does not do is authorise anything. The row is `requested` until the
 * payer's bank says otherwise, and nothing here can write a different status.
 */
export async function requestMandateAction(_previous: unknown, formData: FormData) {
  const provider = resolvePaymentProvider();
  if (!provider.available) {
    return {
      ok: false as const,
      message: `Debit order collection is not available: ${provider.unavailableReason}`,
    };
  }

  const text = (key: string) => String(formData.get(key) ?? '').trim();
  const amountMinor = parseMajorToMinor(text('authorisedAmount'));
  if (amountMinor === null || amountMinor <= 0) {
    return { ok: false as const, message: 'Give the most that may be collected, as an amount.' };
  }

  const accountNumber = text('accountNumber');
  const requested = await command(({ tx, viewer }) =>
    requestMandate(tx, viewer.authUserId, {
      organisationId: String(formData.get('organisationId') ?? ''),
      provider: provider.name,
      authorisedAmountMinor: Number(amountMinor),
      currencyCode: text('currencyCode') || 'ZAR',
      collectionDay: Number(text('collectionDay') || '1'),
      firstCollectionOn: text('firstCollectionOn'),
      accountHolder: text('accountHolder'),
      bankName: text('bankName'),
      branchCode: text('branchCode'),
      accountType: text('accountType') as 'cheque' | 'savings' | 'transmission',
      accountNumber,
    }));
  if (!requested.ok) return requested;

  const { reference } = requested as unknown as { reference: string };
  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';

  let checkout;
  try {
    checkout = await provider.mandateCheckout({
      reference,
      authorisedAmountMinor: Number(amountMinor),
      currencyCode: text('currencyCode') || 'ZAR',
      collectionDay: Number(text('collectionDay') || '1'),
      firstCollectionOn: text('firstCollectionOn'),
      accountHolder: text('accountHolder'),
      bankName: text('bankName'),
      branchCode: text('branchCode'),
      accountType: text('accountType') as 'cheque' | 'savings' | 'transmission',
      accountNumber,
      returnUrl: `${base}/pay/mandate/${reference}`,
      notifyUrl: `${base}/api/payments/${provider.name}/notify`,
    });
  } catch (error) {
    log('error', 'mandate authorisation could not be opened', {
      provider: provider.name,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return {
      ok: false as const,
      message: 'The authorisation page could not be opened. The mandate is saved and waiting; '
        + 'nothing has been authorised.',
    };
  }

  if (checkout.method === 'GET') redirect(checkout.url);
  return { ok: true as const, url: checkout.url, fields: checkout.fields };
}

/**
 * The payer withdrawing their authority.
 *
 * Privileged, because `subscription_mandates` has no UPDATE policy for the
 * application role at all — an authorisation record is not editable by the
 * role that serves web requests. The caller's identity is still on the
 * transaction, so `cancelMandate`'s own permission check in SQL is a real one.
 */
export async function cancelMandateAction(_previous: unknown, formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const result = await command(({ tx, viewer }) =>
    cancelMandate(tx, viewer.authUserId, {
      mandateId: String(formData.get('mandateId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})), { privileged: true });
  if (result.ok) revalidatePath(`/app/${slug}/settings/subscription`);
  return result;
}
