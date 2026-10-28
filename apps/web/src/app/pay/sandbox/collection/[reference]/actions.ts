'use server';

import { redirect } from 'next/navigation';
import { resolvePaymentProvider, signSandboxNotification } from '@propertyos/integrations';
import { log } from '@/lib/logger';

/**
 * The sandbox standing in for the bank's answer to a debit order.
 *
 * In the real thing this arrives days after submission, unprompted, through
 * the notification endpoint — so that is exactly what this does: signs a
 * notification and posts it to the same public endpoint a provider would.
 *
 * The page that reaches it checks for an operator and for the sandbox
 * provider: a customer has no business deciding whether their own debit
 * succeeded.
 */
export async function sandboxCollectionDecideAction(formData: FormData) {
  const provider = resolvePaymentProvider();
  if (provider.name !== 'sandbox' || !provider.available) {
    throw new Error('The sandbox payment provider is not configured on this deployment.');
  }

  const reference = String(formData.get('reference') ?? '');
  const status = String(formData.get('status') ?? '');
  const amountMinor = String(formData.get('amountMinor') ?? '');
  if (!['successful', 'unpaid', 'disputed'].includes(status)) {
    throw new Error('Unknown sandbox collection outcome.');
  }

  const fields: Record<string, string> = {
    kind: 'collection',
    reference,
    provider_reference: `sbx-col-${Date.now().toString(36)}`,
    status,
    amount_minor: status === 'successful' ? amountMinor : '',
    fee_minor: '',
    net_minor: '',
    reason: status === 'unpaid'
      ? 'Insufficient funds'
      : status === 'disputed' ? 'The payer did not recognise the debit' : '',
    event_id: `sbx-cevt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  fields.signature = signSandboxNotification(fields, process.env.PAYMENT_SANDBOX_SECRET ?? '');

  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const response = await fetch(`${base}/api/payments/sandbox/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  log('info', 'sandbox collection notification posted', {
    reference, status, http: response.status,
  });

  // Back to the run, which is both the useful thing for an operator and the
  // only completion signal anything has: without it a caller cannot tell
  // whether the notification has been posted yet, and a browser test racing
  // ahead of it reads as the endpoint rejecting a reference it has never heard
  // of — which is exactly how this was found.
  redirect('/platform/collections');
}
