import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import type { Minor } from './money';
import { nextDocumentNumber } from './numbering';
import { hasPermission, requirePermission, requirePropertyScope } from './permissions';

export type TicketStatus =
  | 'submitted' | 'triaged' | 'awaiting_approval' | 'assigned' | 'in_progress'
  | 'awaiting_confirmation' | 'resolved' | 'closed' | 'on_hold' | 'cancelled';

export type CommentAudience = 'internal' | 'resident_visible' | 'contractor_visible';

/**
 * Permitted state transitions.
 *
 * Declared as data rather than scattered through if-statements, so the whole
 * lifecycle is reviewable in one place and every transition is recorded with its
 * actor and time. Reopening a resolved ticket is allowed and RETAINS the history:
 * the event log is append-only.
 */
const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  submitted:             ['triaged', 'on_hold', 'cancelled'],
  triaged:               ['awaiting_approval', 'assigned', 'on_hold', 'cancelled'],
  awaiting_approval:     ['assigned', 'triaged', 'on_hold', 'cancelled'],
  assigned:              ['in_progress', 'triaged', 'on_hold', 'cancelled'],
  in_progress:           ['awaiting_confirmation', 'resolved', 'on_hold', 'cancelled'],
  awaiting_confirmation: ['resolved', 'in_progress', 'on_hold'],
  resolved:              ['closed', 'in_progress'],   // reopening keeps the history
  closed:                ['in_progress'],             // reopening keeps the history
  on_hold:               ['triaged', 'assigned', 'in_progress', 'cancelled'],
  cancelled:             [],
};

export const createTicketSchema = z.object({
  propertyId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  leaseId: z.string().uuid().optional(),
  residentId: z.string().uuid().optional(),
  category: z.enum([
    'plumbing', 'electrical', 'appliance', 'structural', 'roof', 'heating',
    'pest', 'security', 'grounds', 'other',
  ]),
  location: z.string().trim().max(160).optional(),
  description: z.string().trim().min(10).max(4000),
  urgency: z.enum(['emergency', 'high', 'normal', 'low']).default('normal'),
  accessNotes: z.string().trim().max(1000).optional(),
});

/**
 * Logs a maintenance request.
 *
 * Reachable by an operator (with maintenance.manage) and by a resident on their
 * OWN lease. A resident-reported ticket records the resident's claimed urgency;
 * a manager's assessment is stored separately in `triaged_urgency` so correcting
 * the priority never rewrites what the resident actually reported.
 */
export async function createTicket(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof createTicketSchema>,
  options: { asResident?: boolean } = {},
): Promise<{ ticketId: string; reference: string }> {
  const t = createTicketSchema.parse(input);

  if (options.asResident) {
    if (!t.leaseId) throw invalid('A resident request must be against one of your leases.');
    // The lease must be one the resident actually holds. RLS enforces this on the
    // insert too; checking here produces a readable error instead of a bare denial.
    const [allowed] = await tx<{ ok: boolean }[]>`
      select app.can_access_lease_as_resident(${t.leaseId}::uuid) as ok
    `;
    if (!allowed?.ok) throw notFound('Lease');
  } else {
    await requirePermission(tx, organisationId, 'maintenance.manage');
    await requirePropertyScope(tx, organisationId, t.propertyId);
  }

  const reference = await nextDocumentNumber(tx, organisationId, 'TKT');

  try {
    const [ticket] = await tx<{ id: string }[]>`
      insert into maintenance_tickets (
        organisation_id, reference, property_id, unit_id, lease_id,
        reported_by_user, reported_by_resident, category, location, description,
        urgency, access_notes, status
      ) values (
        ${organisationId}, ${reference}, ${t.propertyId}, ${t.unitId ?? null},
        ${t.leaseId ?? null}, ${actorUserId}, ${t.residentId ?? null},
        ${t.category}, ${t.location ?? null}, ${t.description},
        ${t.urgency}, ${t.accessNotes ?? null}, 'submitted'
      )
      returning id
    `;
    if (!ticket) throw new DomainError('internal', 'Ticket insert returned no row.');

    await tx`
      insert into maintenance_ticket_events (organisation_id, ticket_id, to_status, actor_user_id, note)
      values (${organisationId}, ${ticket.id}, 'submitted', ${actorUserId}, 'Request logged')
    `;

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'maintenance.ticket.created', resourceType: 'maintenance_ticket', resourceId: ticket.id,
      after: { reference, category: t.category, urgency: t.urgency },
    });
    await emitEvent(tx, {
      organisationId,
      eventType: 'maintenance.ticket.created',
      resourceType: 'maintenance_ticket',
      resourceId: ticket.id,
      payload: { reference, urgency: t.urgency, propertyId: t.propertyId },
    });

    return { ticketId: ticket.id, reference };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/** Moves a ticket to a new state, recording actor and time. */
export async function transitionTicket(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    ticketId: string;
    to: TicketStatus;
    note?: string;
    triagedUrgency?: 'emergency' | 'high' | 'normal' | 'low';
    reason?: string;
  },
): Promise<{ from: TicketStatus; to: TicketStatus }> {
  await requirePermission(tx, organisationId, 'maintenance.manage');

  const [ticket] = await tx<{ id: string; status: TicketStatus; property_id: string }[]>`
    select id, status::text as status, property_id from maintenance_tickets
    where id = ${params.ticketId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!ticket) throw notFound('Ticket');
  await requirePropertyScope(tx, organisationId, ticket.property_id);

  const allowed = TRANSITIONS[ticket.status] ?? [];
  if (!allowed.includes(params.to)) {
    throw new DomainError(
      'conflict',
      `A ticket in state "${ticket.status}" cannot move to "${params.to}". ` +
        `Permitted next states: ${allowed.join(', ') || 'none'}.`,
    );
  }
  if ((params.to === 'on_hold' || params.to === 'cancelled') && !params.reason?.trim()) {
    throw invalid(`Moving a ticket to "${params.to}" requires a reason.`);
  }

  // Timestamps are set by a CASE on the target status rather than by splicing
  // SQL fragments, so there is exactly one statement and no conditional
  // interpolation to get wrong.
  await tx`
    update maintenance_tickets set
      status = ${params.to},
      triaged_urgency = coalesce(${params.triagedUrgency ?? null}, triaged_urgency),
      on_hold_reason = case when ${params.to} = 'on_hold' then ${params.reason ?? null}::text else null end,
      cancelled_reason = case when ${params.to} = 'cancelled' then ${params.reason ?? null}::text else null end,
      resolved_at = case when ${params.to} = 'resolved' then now() else resolved_at end,
      closed_at = case when ${params.to} = 'closed' then now() else closed_at end,
      updated_at = now()
    where id = ${params.ticketId}::uuid and organisation_id = ${organisationId}::uuid
  `;

  // Append-only history: reopening never deletes the earlier transitions.
  await tx`
    insert into maintenance_ticket_events (
      organisation_id, ticket_id, from_status, to_status, actor_user_id, note
    ) values (
      ${organisationId}, ${params.ticketId}, ${ticket.status}, ${params.to},
      ${actorUserId}, ${params.note ?? params.reason ?? null}
    )
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'maintenance.ticket.transitioned', resourceType: 'maintenance_ticket',
    resourceId: params.ticketId, reason: params.reason ?? null,
    before: { status: ticket.status }, after: { status: params.to },
  });

  return { from: ticket.status, to: params.to };
}

/**
 * Adds a comment with an explicit audience.
 *
 * The audience is not a display hint: it is the access rule. Row Level Security
 * only exposes `resident_visible` comments to a resident, so an internal note
 * cannot leak through a forgotten filter in a query.
 */
export async function addComment(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { ticketId: string; audience: CommentAudience; body: string },
  options: { asResident?: boolean } = {},
): Promise<{ commentId: string }> {
  if (params.body.trim().length === 0) throw invalid('A comment cannot be empty.');

  if (options.asResident) {
    // A resident may only ever write a resident-visible comment on their own ticket.
    if (params.audience !== 'resident_visible') {
      throw new DomainError('forbidden', 'You can only add comments visible to you and your landlord.');
    }
  } else {
    await requirePermission(tx, organisationId, 'maintenance.manage');
  }

  try {
    const [comment] = await tx<{ id: string }[]>`
      insert into maintenance_comments (organisation_id, ticket_id, author_user_id, audience, body)
      values (${organisationId}, ${params.ticketId}, ${actorUserId}, ${params.audience}, ${params.body})
      returning id
    `;
    if (!comment) throw new DomainError('internal', 'Comment insert returned no row.');
    return { commentId: comment.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/** Records a contractor quotation against a ticket. */
export async function recordQuote(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    ticketId: string; vendorId: string; amountMinor: Minor;
    currencyCode: string; documentId?: string;
  },
): Promise<{ quoteId: string }> {
  await requirePermission(tx, organisationId, 'maintenance.manage');
  if (params.amountMinor <= 0n) throw invalid('A quotation must be a positive amount.');

  const [quote] = await tx<{ id: string }[]>`
    insert into maintenance_quotes (
      organisation_id, ticket_id, vendor_id, amount_minor, currency_code, document_id
    ) values (
      ${organisationId}, ${params.ticketId}, ${params.vendorId},
      ${params.amountMinor.toString()}, ${params.currencyCode}, ${params.documentId ?? null}
    )
    returning id
  `;
  if (!quote) throw new DomainError('internal', 'Quote insert returned no row.');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'maintenance.quote.recorded', resourceType: 'maintenance_quote', resourceId: quote.id,
    after: { ticketId: params.ticketId, amountMinor: params.amountMinor.toString() },
  });
  return { quoteId: quote.id };
}

/**
 * Approves a quotation and issues a work order with a spending ceiling.
 *
 * Approval requires `maintenance.quote.approve`, which is deliberately separate
 * from `maintenance.manage`: triaging a ticket does not authorise spending.
 */
export async function approveQuoteAndIssueWorkOrder(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { quoteId: string; scope: string; appointmentAt?: string; ceilingMinor?: Minor },
): Promise<{ workOrderId: string }> {
  await requirePermission(tx, organisationId, 'maintenance.quote.approve');

  const [quote] = await tx<
    { id: string; ticket_id: string; vendor_id: string; amount_minor: string;
      currency_code: string; status: string }[]
  >`
    select id, ticket_id, vendor_id, amount_minor::text, currency_code, status
    from maintenance_quotes
    where id = ${params.quoteId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!quote) throw notFound('Quotation');
  if (quote.status !== 'submitted') {
    throw new DomainError('conflict', `A quotation that is "${quote.status}" cannot be approved.`);
  }

  const ceiling = params.ceilingMinor ?? BigInt(quote.amount_minor);
  if (ceiling < BigInt(quote.amount_minor)) {
    throw invalid('The spending ceiling cannot be below the approved quotation amount.');
  }

  await tx`
    update maintenance_quotes
    set status = 'approved', approved_by = ${actorUserId}, approved_at = now()
    where id = ${params.quoteId}::uuid
  `;

  const [workOrder] = await tx<{ id: string }[]>`
    insert into work_orders (
      organisation_id, ticket_id, vendor_id, scope, spending_ceiling_minor,
      currency_code, appointment_at, approved_by, approved_at
    ) values (
      ${organisationId}, ${quote.ticket_id}, ${quote.vendor_id}, ${params.scope},
      ${ceiling.toString()}, ${quote.currency_code},
      ${params.appointmentAt ?? null}, ${actorUserId}, now()
    )
    returning id
  `;
  if (!workOrder) throw new DomainError('internal', 'Work order insert returned no row.');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'maintenance.quote.approved', resourceType: 'work_order', resourceId: workOrder.id,
    after: { quoteId: params.quoteId, ceilingMinor: ceiling.toString() },
  });
  await emitEvent(tx, {
    organisationId,
    eventType: 'maintenance.work_order.issued',
    resourceType: 'work_order',
    resourceId: workOrder.id,
    payload: { ticketId: quote.ticket_id, ceilingMinor: ceiling.toString() },
  });

  return { workOrderId: workOrder.id };
}

/**
 * Completes a work order and records the resulting expense exactly once.
 *
 * "A receipt must not be counted twice because it is attached both to a
 * maintenance ticket and to an expense." The expense is created here, linked to
 * the work order, and the unique index on
 * (organisation, vendor, invoice reference) rejects a second recording of the
 * same supplier invoice.
 */
export async function completeWorkOrder(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    workOrderId: string;
    completionNote: string;
    invoiceReference: string;
    invoiceAmountMinor: Minor;
    invoiceDocumentId?: string;
    expenseDate: string;
  },
): Promise<{ expenseId: string; exceededCeiling: boolean }> {
  await requirePermission(tx, organisationId, 'expense.record');

  const [workOrder] = await tx<
    { id: string; ticket_id: string; vendor_id: string | null; currency_code: string;
      spending_ceiling_minor: string | null; status: string }[]
  >`
    select id, ticket_id, vendor_id, currency_code, spending_ceiling_minor::text, status
    from work_orders
    where id = ${params.workOrderId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!workOrder) throw notFound('Work order');
  if (workOrder.status === 'completed') {
    throw new DomainError('conflict', 'This work order is already completed.');
  }

  const [ticket] = await tx<{ property_id: string }[]>`
    select property_id from maintenance_tickets where id = ${workOrder.ticket_id}::uuid
  `;
  if (!ticket) throw notFound('Ticket');

  const [book] = await tx<{ id: string }[]>`
    select id from financial_books where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');

  const ceiling = workOrder.spending_ceiling_minor ? BigInt(workOrder.spending_ceiling_minor) : null;
  const exceededCeiling = ceiling !== null && params.invoiceAmountMinor > ceiling;

  await tx`
    update work_orders set status = 'completed', completed_at = now(),
      completion_note = ${params.completionNote}
    where id = ${params.workOrderId}::uuid
  `;

  try {
    const [expense] = await tx<{ id: string }[]>`
      insert into expenses (
        organisation_id, book_id, property_id, vendor_id, category, cost_class,
        description, amount_minor, currency_code, expense_date, invoice_reference,
        invoice_document_id, work_order_id, status, created_by
      ) values (
        ${organisationId}, ${book.id}, ${ticket.property_id}, ${workOrder.vendor_id},
        'repairs_maintenance', 'operating', ${params.completionNote},
        ${params.invoiceAmountMinor.toString()}, ${workOrder.currency_code},
        ${params.expenseDate}, ${params.invoiceReference}, ${params.invoiceDocumentId ?? null},
        ${params.workOrderId},
        -- An invoice above the approved ceiling stays a draft until someone with
        -- approval authority looks at it.
        ${exceededCeiling ? 'draft' : 'approved'}, ${actorUserId}
      )
      returning id
    `;
    if (!expense) throw new DomainError('internal', 'Expense insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'maintenance.work_order.completed', resourceType: 'work_order',
      resourceId: params.workOrderId,
      after: {
        expenseId: expense.id,
        invoiceAmountMinor: params.invoiceAmountMinor.toString(),
        exceededCeiling,
      },
    });

    return { expenseId: expense.id, exceededCeiling };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const mapped = fromDatabaseError(error);
    if (mapped.code === 'duplicate') {
      throw new DomainError(
        'duplicate',
        `Invoice "${params.invoiceReference}" from this supplier has already been recorded. ` +
          'A supplier invoice is recorded once, even when it is attached to both a ticket and an expense.',
      );
    }
    throw mapped;
  }
}

export async function canApproveSpending(tx: Sql, organisationId: string): Promise<boolean> {
  return hasPermission(tx, organisationId, 'maintenance.quote.approve');
}
