'use server';

import { redirect } from 'next/navigation';
import { resolvePaymentProvider, signSandboxNotification } from '@propertyos/integrations';
import { log } from '@/lib/logger';

/**
 * The sandbox provider deciding what happened.
 *
 * This stands where a real provider's own servers stand, so it behaves like
 * one: it signs a notification and posts it to this product's public
 * notification endpoint over HTTP, rather than reaching into the database. The
 * whole path — signature, verification, dedupe, the attempt, the invoice — is
 * therefore the same path a real provider will travel, which is the only
 * reason a sandbox is worth having.
 *
 * It refuses to run unless the configured provider IS the sandbox, so this
 * page cannot be used to fabricate a notification on a deployment wired to
 * something real.
 */
export async function sandboxDecideAction(formData: FormData) {
  const provider = resolvePaymentProvider();
  if (provider.name !== 'sandbox' || !provider.available) {
    throw new Error('The sandbox payment provider is not configured on this deployment.');
  }

  const reference = String(formData.get('reference') ?? '');
  const status = String(formData.get('status') ?? '');
  const amountMinor = String(formData.get('amountMinor') ?? '0');
  if (!['confirmed', 'failed', 'cancelled'].includes(status)) {
    throw new Error('Unknown sandbox outcome.');
  }

  const fee = status === 'confirmed' ? Math.round(Number(amountMinor) * 0.029) : 0;
  const fields: Record<string, string> = {
    reference,
    provider_reference: `sbx-${Date.now().toString(36)}`,
    status,
    amount_minor: status === 'confirmed' ? amountMinor : '',
    fee_minor: status === 'confirmed' ? String(fee) : '',
    net_minor: status === 'confirmed' ? String(Number(amountMinor) - fee) : '',
    event_id: `sbx-evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  fields.signature = signSandboxNotification(fields, process.env.PAYMENT_SANDBOX_SECRET ?? '');

  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const response = await fetch(`${base}/api/payments/sandbox/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  log('info', 'sandbox notification posted', { reference, status, http: response.status });

  redirect(`/pay/return/${reference}`);
}
