import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, invalid, notFound } from './errors';
import { formatMoney, type Minor } from './money';
import { requirePermission } from './permissions';
import { formatDayMonthYear } from './dates';

/**
 * Sending a month's invoices to the people who owe them.
 *
 * The product could raise invoices and could not send one. What follows is the
 * smallest honest version of that: an operator marks posted invoices ready,
 * looks at the list, and sends them; each one carries the landlord's own
 * wording; and every outcome is recorded as what actually happened.
 *
 * Four rules hold this together, and each exists because its opposite is a way
 * of lying to a resident:
 *
 *  1. **Only a posted invoice can be sent.** A draft is not in anyone's books
 *     and can still change. Emailing one invites payment against a figure that
 *     does not exist yet.
 *
 *  2. **Delivery never touches the accounting record.** `charge_documents` is
 *     immutable once posted; whether somebody was told lives in its own table
 *     and changes nothing about the balance.
 *
 *  3. **"Sent" means a provider acknowledged it.** Nothing here writes `sent`
 *     for having tried. With no provider configured — which is this
 *     deployment's actual state — the outcome is `undelivered` with the reason
 *     in words, and the screen says so.
 *
 *  4. **A resident with no email address is suppressed, visibly.** Not skipped
 *     quietly, not counted as sent. The operator sees who was not reached and
 *     why, because they are the one who has to do something about it.
 */

/* ------------------------------------------------------------ merge fields */

export interface MessageField {
  key: string;
  label: string;
  example: string;
}

/**
 * What the landlord may put in the message.
 *
 * Deliberately small: who it is to, what it is for, what it comes to, when it
 * is due, and where to look. Everything here is a fact already on the invoice,
 * so nothing in a message can assert something the ledger does not.
 */
export const INVOICE_MESSAGE_FIELDS: readonly MessageField[] = [
  { key: 'resident.first_name', label: 'Resident first name', example: 'Thandiwe' },
  { key: 'resident.full_name', label: 'Resident full name', example: 'Thandiwe Mokoena' },
  { key: 'invoice.number', label: 'Invoice number', example: 'INV-000042' },
  { key: 'invoice.period', label: 'Period billed', example: '1 November 2026 to 30 November 2026' },
  { key: 'invoice.total', label: 'Amount of this invoice', example: 'R8,350.00' },
  { key: 'invoice.due_date', label: 'Due date', example: '01/11/2026' },
  { key: 'lease.reference', label: 'Lease reference', example: 'LSE-000001' },
  { key: 'unit.label', label: 'Property and unit', example: '14 Protea Street / MAIN' },
  { key: 'landlord.name', label: 'Landlord or agency name', example: 'Blue Crane Rentals' },
  { key: 'portal.link', label: 'Link to their statement', example: 'https://…/portal/…' },
] as const;

const FIELD_KEYS = new Set(INVOICE_MESSAGE_FIELDS.map((f) => f.key));
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/gi;

export interface MessageRender {
  text: string;
  /** Placeholders that resolved to nothing. */
  missing: string[];
  /** Placeholders this product does not define — almost always a typo. */
  unknown: string[];
}

/**
 * Fills a message in.
 *
 * An unknown placeholder is left exactly as written rather than blanked: the
 * author typed it, and showing it back is how they find the typo. A known
 * placeholder with no value is reported as missing so the editor can say which
 * invoices would go out incomplete.
 */
export function renderMessage(body: string, values: Record<string, string>): MessageRender {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const text = body.replace(PLACEHOLDER, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!FIELD_KEYS.has(key)) {
      unknown.add(key);
      return whole;
    }
    const value = values[key];
    if (value === undefined || value.trim() === '') {
      missing.add(key);
      return `[${key}]`;
    }
    return value;
  });
  return { text, missing: [...missing].sort(), unknown: [...unknown].sort() };
}

/** Every placeholder a body uses, for the editor's warnings. */
export function messagePlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!.toLowerCase()))].sort();
}

export interface MessageTemplate {
  subject: string;
  body: string;
  /** False when nobody has written their own and the product default is in use. */
  customised: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

/**
 * The product's default wording.
 *
 * Written to be defensible as it stands: it states what the invoice is, what it
 * comes to, when it is due and where to see the account. It claims nothing
 * about payment having been received and threatens nothing.
 */
export const DEFAULT_INVOICE_MESSAGE = {
  subject: 'Your invoice {{invoice.number}} for {{invoice.period}}',
  body: [
    'Dear {{resident.first_name}},',
    '',
    'Please find your invoice for {{unit.label}}.',
    '',
    'Invoice: {{invoice.number}}',
    'Period: {{invoice.period}}',
    'Amount: {{invoice.total}}',
    'Due: {{invoice.due_date}}',
    '',
    'You can see this invoice, your full statement and how to pay at',
    '{{portal.link}}',
    '',
    'If anything here looks wrong, please reply to this message and we will',
    'look into it.',
    '',
    '{{landlord.name}}',
  ].join('\n'),
} as const;

/* ------------------------------------------------------- the template store */

export async function getInvoiceMessageTemplate(
  tx: Sql, organisationId: string,
): Promise<MessageTemplate> {
  const [row] = await tx<
    { subject: string; body: string; updated_at: string; updated_by_name: string | null }[]
  >`
    select t.subject, t.body, t.updated_at::text, u.full_name as updated_by_name
      from organisation_message_templates t
      left join user_profiles u on u.auth_user_id = t.updated_by
     where t.organisation_id = ${organisationId}::uuid
       and t.template_key = 'invoice.issued'
  `;
  if (!row) {
    return {
      subject: DEFAULT_INVOICE_MESSAGE.subject,
      body: DEFAULT_INVOICE_MESSAGE.body,
      customised: false,
      updatedAt: null,
      updatedByName: null,
    };
  }
  return {
    subject: row.subject,
    body: row.body,
    customised: true,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

/** Saves the landlord's own wording. Refuses a body nobody could act on. */
export async function setInvoiceMessageTemplate(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { subject: string; body: string },
): Promise<MessageTemplate> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length < 3) throw invalid('Give the message a subject line.');
  if (body.length < 20) throw invalid('That message is too short to be worth sending.');
  if (body.length > 4000) throw invalid('That message is too long. Keep it under 4,000 characters.');

  const unknown = messagePlaceholders(body)
    .concat(messagePlaceholders(subject))
    .filter((key) => !FIELD_KEYS.has(key));
  if (unknown.length > 0) {
    // Refused rather than sent with the braces showing. A resident reading
    // "{{tenant.name}}" learns that nobody checked.
    throw invalid(
      `This product does not fill in ${unknown.map((k) => `{{${k}}}`).join(', ')}. `
      + 'Remove it, or use one of the fields listed beside the editor.',
    );
  }

  await tx`
    insert into organisation_message_templates (
      organisation_id, template_key, subject, body, updated_by)
    values (${organisationId}::uuid, 'invoice.issued', ${subject}, ${body}, ${actorUserId}::uuid)
    on conflict (organisation_id, template_key) do update set
      subject = excluded.subject, body = excluded.body,
      updated_at = now(), updated_by = excluded.updated_by
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'message_template.updated', resourceType: 'organisation',
    resourceId: organisationId,
    after: { templateKey: 'invoice.issued', subjectLength: subject.length, bodyLength: body.length },
  });
  return getInvoiceMessageTemplate(tx, organisationId);
}

/** Puts the product's default back. */
export async function resetInvoiceMessageTemplate(
  tx: Sql, organisationId: string, actorUserId: string,
): Promise<MessageTemplate> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  await tx`
    delete from organisation_message_templates
     where organisation_id = ${organisationId}::uuid and template_key = 'invoice.issued'
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'message_template.reset', resourceType: 'organisation',
    resourceId: organisationId,
  });
  return getInvoiceMessageTemplate(tx, organisationId);
}

/* ------------------------------------------------------------- the invoices */

export type DeliveryState = 'not_ready' | 'ready' | 'queued' | 'sent' | 'undelivered' | 'suppressed';

export interface InvoiceForSending {
  documentId: string;
  documentNumber: string;
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  residentName: string | null;
  residentEmail: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  issueDate: string;
  dueDate: string;
  totalMinor: Minor;
  currencyCode: string;
  state: DeliveryState;
  outcomeDetail: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
}

/**
 * What counts as an invoice to send.
 *
 * The documents a billing run raises, and nothing else. A credit note is not a
 * demand for money, an opening balance is a figure carried in from before this
 * product, and an ad-hoc adjustment is a conversation somebody is already
 * having — sending any of them as "your invoice" would misdescribe it.
 */
export const SENDABLE_DOCUMENT_TYPES = ['rent_invoice', 'utility_invoice'] as const;

/**
 * The month's posted invoices and where each one stands.
 *
 * Reversed documents and credit notes are not here: a reversal is not an
 * invoice, and sending one as if it were would be the product inventing a
 * demand for money.
 */
export async function listInvoicesForSending(
  tx: Sql,
  organisationId: string,
  filter: { periodStart?: string; periodEnd?: string; state?: DeliveryState } = {},
): Promise<InvoiceForSending[]> {
  const rows = await tx<
    { document_id: string; document_number: string; lease_id: string; lease_reference: string;
      unit_label: string; resident_name: string | null; resident_email: string | null;
      period_start: string | null; period_end: string | null; issue_date: string;
      due_date: string; total_minor: string; currency_code: string;
      state: string | null; outcome_detail: string | null; last_attempt_at: string | null;
      sent_at: string | null }[]
  >`
    select cd.id as document_id, cd.document_number, cd.lease_id, l.reference as lease_reference,
           p.name || ' / ' || u.code as unit_label,
           nullif(trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, '')), '')
             as resident_name,
           rp.email::text as resident_email,
           cd.period_start::text, cd.period_end::text, cd.issue_date::text, cd.due_date::text,
           cd.total_minor::text, cd.currency_code,
           d.state, d.outcome_detail, d.last_attempt_at::text, d.sent_at::text
      from charge_documents cd
      join leases l on l.organisation_id = cd.organisation_id and l.id = cd.lease_id
      join properties p on p.organisation_id = l.organisation_id and p.id = l.property_id
      join units u on u.organisation_id = l.organisation_id and u.id = l.unit_id
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
      left join invoice_deliveries d
        on d.organisation_id = cd.organisation_id and d.document_id = cd.id
     where cd.organisation_id = ${organisationId}::uuid
       and cd.document_type = any(${SENDABLE_DOCUMENT_TYPES as unknown as string[]}::app.charge_document_type[])
       and cd.status = 'posted'
       and cd.reversed_by_document_id is null
       ${filter.periodStart
         ? tx`and coalesce(cd.period_start, cd.issue_date) >= ${filter.periodStart}::date` : tx``}
       ${filter.periodEnd
         ? tx`and coalesce(cd.period_start, cd.issue_date) <= ${filter.periodEnd}::date` : tx``}
       ${filter.state === 'not_ready'
         ? tx`and d.document_id is null`
         : filter.state ? tx`and d.state = ${filter.state}` : tx``}
     order by coalesce(cd.period_start, cd.issue_date) desc, cd.document_number
     limit 500
  `;
  return rows.map((r) => ({
    documentId: r.document_id,
    documentNumber: r.document_number,
    leaseId: r.lease_id,
    leaseReference: r.lease_reference,
    unitLabel: r.unit_label,
    residentName: r.resident_name,
    residentEmail: r.resident_email,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    totalMinor: BigInt(r.total_minor),
    currencyCode: r.currency_code,
    state: (r.state as DeliveryState | null) ?? 'not_ready',
    outcomeDetail: r.outcome_detail,
    lastAttemptAt: r.last_attempt_at,
    sentAt: r.sent_at,
  }));
}

/**
 * The month the screen should open on.
 *
 * The latest month that actually has posted invoices, not today's: a landlord
 * who bills on the first and opens this on the fifteenth wants the invoices
 * they just raised, and an empty current month reads as "nothing was billed".
 * Null when nothing has ever been posted.
 */
export async function latestInvoicedMonth(
  tx: Sql, organisationId: string,
): Promise<string | null> {
  const [row] = await tx<{ period: string | null }[]>`
    select to_char(max(coalesce(cd.period_start, cd.issue_date)), 'YYYY-MM') as period
      from charge_documents cd
     where cd.organisation_id = ${organisationId}::uuid
       and cd.document_type = any(${SENDABLE_DOCUMENT_TYPES as unknown as string[]}::app.charge_document_type[])
       and cd.status = 'posted'
  `;
  return row?.period ?? null;
}

/** How many are waiting to go out. For the overview's queue. */
export async function countInvoicesReadyToSend(
  tx: Sql, organisationId: string,
): Promise<number> {
  const [row] = await tx<{ total: string }[]>`
    select count(*)::text as total from invoice_deliveries
     where organisation_id = ${organisationId}::uuid and state = 'ready'
  `;
  return Number(row?.total ?? '0');
}

/* -------------------------------------------------------------- the commands */

/**
 * Marks posted invoices ready to go.
 *
 * Refuses anything that is not a posted, unreversed invoice, and says which —
 * a bulk action that silently drops half its input is how an operator comes to
 * believe a resident was invoiced.
 */
export async function markInvoicesReadyToSend(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { documentIds: string[] },
): Promise<{ marked: number; alreadySent: string[] }> {
  await requirePermission(tx, organisationId, 'invoice.send');
  if (input.documentIds.length === 0) throw invalid('Choose at least one invoice.');

  const eligible = await tx<{ id: string; document_number: string; status: string;
    reversed: boolean; state: string | null }[]>`
    select cd.id, cd.document_number, cd.status::text,
           cd.reversed_by_document_id is not null as reversed, d.state
      from charge_documents cd
      left join invoice_deliveries d
        on d.organisation_id = cd.organisation_id and d.document_id = cd.id
     where cd.organisation_id = ${organisationId}::uuid
       and cd.id = any(${input.documentIds}::uuid[])
       and cd.document_type = any(${SENDABLE_DOCUMENT_TYPES as unknown as string[]}::app.charge_document_type[])
  `;
  const found = new Set(eligible.map((e) => e.id));
  const missing = input.documentIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw notFound('One of those invoices');

  const unposted = eligible.filter((e) => e.status !== 'posted' || e.reversed);
  if (unposted.length > 0) {
    throw new DomainError(
      'conflict',
      `${unposted.map((u) => u.document_number).join(', ')} `
      + `${unposted.length === 1 ? 'is' : 'are'} not a posted invoice. Only an invoice that is `
      + 'in the books can be sent: a draft can still change, and a reversed one is not owed.',
    );
  }

  const alreadySent = eligible.filter((e) => e.state === 'sent').map((e) => e.document_number);
  const sendable = eligible.filter((e) => e.state !== 'sent').map((e) => e.id);

  if (sendable.length > 0) {
    await tx`
      insert into invoice_deliveries (
        organisation_id, document_id, state, marked_ready_by)
      select ${organisationId}::uuid, id, 'ready', ${actorUserId}::uuid
        from unnest(${sendable}::uuid[]) as t(id)
      on conflict (document_id) do update set
        state = 'ready', marked_ready_at = now(), marked_ready_by = ${actorUserId}::uuid,
        outcome_detail = null
    `;
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'invoice.marked_ready', resourceType: 'charge_document',
      after: { count: sendable.length },
    });
  }
  return { marked: sendable.length, alreadySent };
}

/** Takes an invoice back out of the outgoing pile. */
export async function withdrawInvoiceFromSending(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { documentId: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'invoice.send');
  const [row] = await tx<{ state: string }[]>`
    delete from invoice_deliveries
     where organisation_id = ${organisationId}::uuid
       and document_id = ${input.documentId}::uuid
       and state in ('ready', 'undelivered', 'suppressed')
    returning state
  `;
  if (!row) {
    throw new DomainError(
      'conflict',
      'That invoice is not waiting to be sent. A message already sent cannot be unsent.',
    );
  }
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'invoice.withdrawn_from_sending', resourceType: 'charge_document',
    resourceId: input.documentId,
  });
}

export interface QueueOutcome {
  queued: number;
  /** Invoices with nobody to send to, and who they were for. */
  suppressed: Array<{ documentNumber: string; reason: string }>;
}

/**
 * Hands every ready invoice to the worker, with the message already rendered.
 *
 * Rendered HERE, inside the transaction that queues it, so the message a
 * resident receives is the one the operator could have previewed — not one
 * re-rendered later from a template somebody edited in between.
 *
 * Nothing is sent by this function. It writes the message, marks the delivery
 * queued and emits one event per invoice; the worker does the sending and
 * records what came back.
 */
export async function queueReadyInvoices(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { portalBaseUrl: string; correlationId?: string },
): Promise<QueueOutcome> {
  await requirePermission(tx, organisationId, 'invoice.send');

  const template = await getInvoiceMessageTemplate(tx, organisationId);
  const [landlord] = await tx<{ name: string | null }[]>`
    select coalesce(nullif(trim(op.trading_name), ''), nullif(trim(op.legal_name), ''), o.name)
             as name
      from organisations o
      left join organisation_profiles op on op.organisation_id = o.id
     where o.id = ${organisationId}::uuid
  `;

  const ready = await listInvoicesForSending(tx, organisationId, { state: 'ready' });
  const outcome: QueueOutcome = { queued: 0, suppressed: [] };

  for (const invoice of ready) {
    if (!invoice.residentEmail) {
      // Not skipped and not counted as sent: recorded, with the reason, where
      // the operator will see it.
      await tx`
        update invoice_deliveries
           set state = 'suppressed',
               outcome_detail = 'No email address on file for this resident.',
               last_attempt_at = now()
         where organisation_id = ${organisationId}::uuid
           and document_id = ${invoice.documentId}::uuid
      `;
      outcome.suppressed.push({
        documentNumber: invoice.documentNumber,
        reason: 'No email address on file for this resident.',
      });
      continue;
    }

    const values: Record<string, string> = {
      'resident.first_name': (invoice.residentName ?? '').split(' ')[0] ?? '',
      'resident.full_name': invoice.residentName ?? '',
      'invoice.number': invoice.documentNumber,
      'invoice.period': invoice.periodStart && invoice.periodEnd
        ? `${formatDayMonthYear(invoice.periodStart)} to ${formatDayMonthYear(invoice.periodEnd)}`
        : formatDayMonthYear(invoice.issueDate),
      // With the symbol: a resident reading "9,000.00" in an email has to
      // guess the currency, and a landlord with a foreign tenant finds out why
      // that matters.
      'invoice.total': formatMoney(invoice.totalMinor, invoice.currencyCode),
      'invoice.due_date': formatDayMonthYear(invoice.dueDate),
      'lease.reference': invoice.leaseReference,
      'unit.label': invoice.unitLabel,
      'landlord.name': landlord?.name ?? '',
      'portal.link': `${input.portalBaseUrl.replace(/\/$/, '')}/portal/${invoice.leaseId}`,
    };

    const subject = renderMessage(template.subject, values).text;
    const body = renderMessage(template.body, values).text;

    const [notification] = await tx<{ id: string }[]>`
      insert into notifications (
        organisation_id, template_key, channel, recipient_email, recipient_resident_id,
        subject, body, status)
      values (
        ${organisationId}::uuid, null, 'email', ${invoice.residentEmail},
        (select lp.resident_id from lease_parties lp
          where lp.lease_id = ${invoice.leaseId}::uuid
            and lp.role = 'primary_resident' and lp.removed_on is null
          limit 1),
        ${subject}, ${body}, 'queued')
      returning id
    `;

    await tx`
      update invoice_deliveries
         set state = 'queued', queued_at = now(), notification_id = ${notification!.id}::uuid,
             recipient_email = ${invoice.residentEmail},
             attempts = attempts + 1, outcome_detail = null
       where organisation_id = ${organisationId}::uuid
         and document_id = ${invoice.documentId}::uuid
    `;

    await emitEvent(tx, {
      organisationId,
      eventType: 'invoice.message.queued',
      resourceType: 'charge_document',
      resourceId: invoice.documentId,
      payload: { notificationId: notification!.id, documentId: invoice.documentId },
      correlationId: input.correlationId,
    });
    outcome.queued += 1;
  }

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'invoice.messages_queued', resourceType: 'organisation',
    resourceId: organisationId,
    after: { queued: outcome.queued, suppressed: outcome.suppressed.length },
  });
  return outcome;
}

/**
 * What the worker found out, written back.
 *
 * `sent` is only ever passed by an adapter that received an acknowledgement.
 * Everything else — including a development sink with no provider behind it —
 * is `undelivered` with the reason in words.
 */
export async function recordInvoiceDeliveryOutcome(
  tx: Sql, organisationId: string,
  input: { documentId: string; delivered: boolean; detail: string },
): Promise<void> {
  await tx`
    update invoice_deliveries
       set state = ${input.delivered ? 'sent' : 'undelivered'},
           sent_at = ${input.delivered ? tx`now()` : null},
           last_attempt_at = now(),
           outcome_detail = ${input.detail}
     where organisation_id = ${organisationId}::uuid
       and document_id = ${input.documentId}::uuid
  `;
}
