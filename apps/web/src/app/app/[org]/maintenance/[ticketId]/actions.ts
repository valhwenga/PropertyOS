'use server';

import { revalidatePath } from 'next/cache';
import {
  addComment, approveQuoteAndIssueWorkOrder, completeWorkOrder, declineQuote,
  parseMajorToMinor, recordQuote, transitionTicket,
  type CommentAudience, type TicketStatus,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

export async function transitionTicketAction(
  _previous: unknown,
  formData: FormData,
) {
  const org = String(formData.get('org'));
  const ticketId = String(formData.get('ticketId'));
  const to = String(formData.get('to')) as TicketStatus;
  const note = String(formData.get('note') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  const triagedUrgency = String(formData.get('triagedUrgency') ?? '').trim();

  const result = await command(async ({ tx, viewer }) => {
    // The slug is resolved against the viewer's own memberships, never trusted.
    const context = await requireOperator(org);
    return transitionTicket(tx, context.organisationId, viewer.authUserId, {
      ticketId,
      to,
      note: note || undefined,
      reason: reason || undefined,
      triagedUrgency: (triagedUrgency || undefined) as 'emergency' | 'high' | 'normal' | 'low' | undefined,
    });
  });

  if (result.ok) revalidatePath(`/app/${org}/maintenance/${ticketId}`);
  return result;
}

export async function addCommentAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const ticketId = String(formData.get('ticketId'));
  const audience = String(formData.get('audience')) as CommentAudience;
  const body = String(formData.get('body') ?? '');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return addComment(tx, context.organisationId, viewer.authUserId, {
      ticketId, audience, body,
    });
  });

  if (result.ok) revalidatePath(`/app/${org}/maintenance/${ticketId}`);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Spending                                                                   */
/* -------------------------------------------------------------------------- */
//
// None of this chain was reachable: `recordQuote`,
// `approveQuoteAndIssueWorkOrder` and `completeWorkOrder` existed with no
// screen, so maintenance spending could not happen in the product at all, and
// the approvals queue listed submitted quotations with nothing to do about
// them.
//
// Approving a quotation needs `maintenance.quote.approve`, deliberately
// separate from triaging a ticket. The domain enforces it; these actions do
// not re-decide it.

export async function recordQuoteAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const ticketId = String(formData.get('ticketId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return recordQuote(tx, context.organisationId, viewer.authUserId, {
      ticketId,
      vendorId: String(formData.get('vendorId')),
      amountMinor: parseMajorToMinor(
        String(formData.get('amount') ?? ''), context.currencyCode,
      ),
      currencyCode: context.currencyCode,
      documentId: String(formData.get('documentId') ?? '') || undefined,
    });
  });

  if (result.ok) revalidatePath(`/app/${org}/maintenance/${ticketId}`);
  return result;
}

export async function approveQuoteAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const ticketId = String(formData.get('ticketId'));
  const ceiling = String(formData.get('ceiling') ?? '').trim();

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return approveQuoteAndIssueWorkOrder(tx, context.organisationId, viewer.authUserId, {
      quoteId: String(formData.get('quoteId')),
      scope: String(formData.get('scope') ?? ''),
      appointmentAt: String(formData.get('appointmentAt') ?? '') || undefined,
      // Left blank, the ceiling is the quotation itself. The domain refuses a
      // ceiling below it, so an approval can never authorise less than it
      // approved.
      ceilingMinor: ceiling ? parseMajorToMinor(ceiling, context.currencyCode) : undefined,
    });
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/maintenance/${ticketId}`);
    revalidatePath(`/app/${org}/approvals`);
  }
  return result;
}

export async function declineQuoteAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const ticketId = String(formData.get('ticketId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await declineQuote(tx, context.organisationId, viewer.authUserId, {
      quoteId: String(formData.get('quoteId')),
      reason: String(formData.get('reason') ?? ''),
    });
    return { declined: true };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/maintenance/${ticketId}`);
    revalidatePath(`/app/${org}/approvals`);
  }
  return result;
}

/**
 * Completing a work order creates the expense for the supplier's invoice.
 *
 * The expense is created as a draft, so the cost still goes through expense
 * approval before it reaches the books. An invoice over the approved ceiling is
 * not refused — it happened — but it is visible as having exceeded it.
 */
export async function completeWorkOrderAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const ticketId = String(formData.get('ticketId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return completeWorkOrder(tx, context.organisationId, viewer.authUserId, {
      workOrderId: String(formData.get('workOrderId')),
      completionNote: String(formData.get('completionNote') ?? ''),
      invoiceReference: String(formData.get('invoiceReference') ?? ''),
      invoiceAmountMinor: parseMajorToMinor(
        String(formData.get('invoiceAmount') ?? ''), context.currencyCode,
      ),
      invoiceDocumentId: String(formData.get('invoiceDocumentId') ?? '') || undefined,
      expenseDate: String(formData.get('expenseDate') ?? ''),
    });
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/maintenance/${ticketId}`);
    revalidatePath(`/app/${org}/expenses`);
  }
  return result;
}
