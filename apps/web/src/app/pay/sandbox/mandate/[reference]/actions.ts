'use server';

import { redirect } from 'next/navigation';
import { resolvePaymentProvider, signSandboxNotification } from '@propertyos/integrations';
import { log } from '@/lib/logger';

/**
 * The sandbox standing in for a payer's bank.
 *
 * It signs a mandate notification and posts it to this product's own public
 * notification endpoint, exactly as a provider's servers would, so the
 * signature check, the dedupe and the authentication path are the real ones.
 *
 * What no sandbox can imitate is the part that matters under DebiCheck: a
 * payer approving the authority inside their own banking app. The page says
 * so.
 */
export async function sandboxMandateDecideAction(formData: FormData) {
  const provider = resolvePaymentProvider();
  if (provider.name !== 'sandbox' || !provider.available) {
    throw new Error('The sandbox payment provider is not configured on this deployment.');
  }

  const reference = String(formData.get('reference') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!['authenticated', 'rejected', 'cancelled'].includes(status)) {
    throw new Error('Unknown sandbox mandate outcome.');
  }

  const fields: Record<string, string> = {
    kind: 'mandate',
    reference,
    provider_reference: `sbx-man-${Date.now().toString(36)}`,
    status,
    amount_minor: '',
    fee_minor: '',
    net_minor: '',
    reason: status === 'rejected' ? 'The payer declined it in their banking app' : '',
    event_id: `sbx-mevt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  fields.signature = signSandboxNotification(fields, process.env.PAYMENT_SANDBOX_SECRET ?? '');

  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const response = await fetch(`${base}/api/payments/sandbox/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  log('info', 'sandbox mandate notification posted', { reference, status, http: response.status });

  redirect(`/pay/mandate/${reference}`);
}
