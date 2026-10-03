'use server';

import { revalidatePath } from 'next/cache';
import { addComment, transitionTicket, type CommentAudience, type TicketStatus } from '@propertyos/domain';
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
