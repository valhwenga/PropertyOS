'use server';

import { revalidatePath } from 'next/cache';
import {
  parseMajorToMinor, recordSubscriptionPayment, runSubscriptionBilling, saveBillingSettings,
  voidSubscriptionInvoice,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Spike's own billing: its invoicing identity, the monthly run, payments and
 * voids.
 *
 * Not privileged. Every policy involved is keyed on
 * `app.is_platform_operator()`, so an operator writes these rows under their
 * own RLS context, and the second-factor check inside each domain function runs
 * in SQL exactly as it does everywhere else.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function saveBillingSettingsAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    saveBillingSettings(tx, viewer.authUserId, {
      legalName: str(formData, 'legalName'),
      address: str(formData, 'address'),
      email: str(formData, 'email'),
      vatNumber: str(formData, 'vatNumber'),
      vatRateBp: str(formData, 'vatRateBp'),
      bankDetails: str(formData, 'bankDetails'),
      paymentTermsDays: str(formData, 'paymentTermsDays'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/billing');
  return result;
}

export async function runBillingAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    const outcome = await runSubscriptionBilling(tx, viewer.authUserId, {
      periodStart: str(formData, 'periodStart'),
      issueDate: str(formData, 'issueDate'),
    });
    // Carried back to the screen rather than summarised: who was billed, who
    // was not, and why not, is the whole result of pressing this button.
    return {
      issuedCount: outcome.issued.length,
      totalMinor: outcome.totalMinor,
      issued: outcome.issued,
      skipped: outcome.skipped,
      periodStart: outcome.periodStart,
    };
  });
  if (result.ok) revalidatePath('/platform/billing');
  return result;
}

export async function recordPaymentAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    // The field holds rands, as somebody reading a bank statement types them.
    // Passing that string into a field the domain reads as CENTS would record
    // R2.99 for R299.00 — the kind of defect that only shows up in a figure
    // somebody trusts, months later.
    const outcome = await recordSubscriptionPayment(tx, viewer.authUserId, {
      invoiceId: str(formData, 'invoiceId'),
      paidOn: str(formData, 'paidOn'),
      amountMinor: Number(parseMajorToMinor(str(formData, 'amount'), str(formData, 'currency') || 'ZAR')),
      reference: str(formData, 'reference'),
    });
    return outcome;
  });
  if (result.ok) revalidatePath('/platform/billing');
  return result;
}

export async function voidInvoiceAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    voidSubscriptionInvoice(tx, viewer.authUserId, {
      invoiceId: str(formData, 'invoiceId'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/billing');
  return result;
}
