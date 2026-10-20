'use server';

import { revalidatePath } from 'next/cache';
import {
  markInvoicesReadyToSend, queueReadyInvoices, withdrawInvoiceFromSending,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/** Every id the form carried, de-duplicated and kept in order. */
function ids(formData: FormData): string[] {
  return [...new Set(formData.getAll('documentId').map(String).filter(Boolean))];
}

export async function markReadyAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return markInvoicesReadyToSend(tx, context.organisationId, viewer.authUserId, {
      documentIds: ids(formData),
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/billing/invoices`);
  return result;
}

export async function withdrawAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await withdrawInvoiceFromSending(tx, context.organisationId, viewer.authUserId, {
      documentId: String(formData.get('documentId') ?? ''),
    });
    return { withdrawn: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/billing/invoices`);
  return result;
}

/**
 * Hands every ready invoice to the worker.
 *
 * The base URL comes from configuration rather than from the request, because
 * it ends up in an email: a link built from a header somebody else controls is
 * a link somebody else chooses.
 */
export async function sendReadyAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org') ?? '');
  const result = await command(async ({ tx, viewer, correlationId }) => {
    const context = await requireOperator(org);
    return queueReadyInvoices(tx, context.organisationId, viewer.authUserId, {
      portalBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
      correlationId,
    });
  });
  if (result.ok) {
    revalidatePath(`/app/${org}/billing/invoices`);
    revalidatePath(`/app/${org}`);
  }
  return result;
}
