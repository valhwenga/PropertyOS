import type { Sql } from '@propertyos/db';
import { notFound } from './errors';
import type { Minor } from './money';

/**
 * Everything an invoice has to say, read from what was actually posted.
 *
 * An invoice is not a statement. A statement says what an account has done and
 * changes every time money moves; an invoice says what was charged on one date,
 * what it was for, and what reference to quote when paying it — and it does not
 * change afterwards. That is why this reads the charge document and its lines
 * and nothing else about the balance: a figure on an invoice that drifts is
 * worse than no invoice.
 *
 * There are two readers and they are not given the same path. An operator reads
 * the tables under their own row-level security. A resident is a member of
 * nothing, so the parts of this that live on organisation tables — who the
 * landlord is, where to pay — come from the `security definer` functions built
 * for exactly that, and the id in their URL decides nothing.
 */

export interface InvoiceLine {
  lineNumber: number;
  category: string;
  description: string;
  amountMinor: Minor;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  /** Set only where the line was prorated, so the document can show the sum. */
  proration: {
    numerator: number;
    denominator: number;
    fullPeriodAmountMinor: Minor;
  } | null;
}

export interface InvoiceLandlord {
  legalName: string | null;
  tradingName: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  physicalAddress: string | null;
  phone: string | null;
  email: string | null;
  agentName: string | null;
  agentContact: string | null;
}

export interface InvoicePayTo {
  bankName: string;
  accountHolder: string;
  accountNumberLast4: string;
  branchCode: string | null;
}

export interface InvoiceDocument {
  documentId: string;
  documentNumber: string;
  documentType: string;
  status: string;
  issueDate: string;
  dueDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  currencyCode: string;
  totalMinor: Minor;
  lines: InvoiceLine[];
  /** Also the reference a tenant must quote: it is what reconciliation matches on. */
  leaseReference: string;
  propertyName: string;
  unitCode: string;
  propertyAddress: string[];
  residentName: string;
  residentEmail: string | null;
  landlord: InvoiceLandlord;
  /** Null where no verified operating account exists; the document then says so. */
  payTo: InvoicePayTo | null;
  /** True once a credit note has reversed it; the document says so in large type. */
  reversed: boolean;
}

interface DocumentRow {
  id: string; document_number: string; document_type: string; status: string;
  issue_date: string; due_date: string; period_start: string | null;
  period_end: string | null; currency_code: string; total_minor: string;
  lease_id: string; lease_reference: string; property_name: string; unit_code: string;
  address_line1: string; address_line2: string | null; suburb: string | null;
  city: string; province: string | null; postal_code: string | null;
  resident_name: string | null; resident_email: string | null;
  reversed_by_document_id: string | null;
}

interface LineRow {
  line_number: number; category: string; description: string; amount_minor: string;
  service_period_start: string | null; service_period_end: string | null;
  prorated: boolean; proration_numerator: number | null;
  proration_denominator: number | null; full_period_amount_minor: string | null;
}

/** The address as lines, with the parts that were never captured left out. */
function addressLines(row: DocumentRow): string[] {
  return [
    row.address_line1,
    row.address_line2,
    [row.suburb, row.city].filter(Boolean).join(', '),
    [row.province, row.postal_code].filter(Boolean).join(' '),
  ].filter((line): line is string => Boolean(line && line.trim()));
}

function toLines(rows: LineRow[]): InvoiceLine[] {
  return rows.map((row) => ({
    lineNumber: row.line_number,
    category: row.category,
    description: row.description,
    amountMinor: BigInt(row.amount_minor),
    servicePeriodStart: row.service_period_start,
    servicePeriodEnd: row.service_period_end,
    proration: row.prorated && row.proration_numerator !== null
      && row.proration_denominator !== null && row.full_period_amount_minor !== null
      ? {
        numerator: row.proration_numerator,
        denominator: row.proration_denominator,
        fullPeriodAmountMinor: BigInt(row.full_period_amount_minor),
      }
      : null,
  }));
}

/**
 * The invoice an operator asked for.
 *
 * Scoped to the organisation in the URL as well as to the caller's own
 * row-level security, so a document id from another customer produces the same
 * "not found" as one that does not exist.
 */
export async function loadInvoiceForOperator(
  tx: Sql, organisationId: string, documentId: string,
): Promise<InvoiceDocument> {
  const [document] = await tx<DocumentRow[]>`
    select d.id, d.document_number, d.document_type::text, d.status::text,
           d.issue_date::text, d.due_date::text, d.period_start::text, d.period_end::text,
           d.currency_code, d.total_minor::text, d.lease_id, d.reversed_by_document_id,
           l.reference as lease_reference,
           p.name as property_name, u.code as unit_code,
           p.address_line1, p.address_line2, p.suburb, p.city, p.province, p.postal_code,
           (rp.first_name || ' ' || rp.last_name) as resident_name,
           rp.email::text as resident_email
      from charge_documents d
      join leases l on l.id = d.lease_id
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp on lp.lease_id = l.id
        and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where d.id = ${documentId}::uuid and d.organisation_id = ${organisationId}::uuid
  `;
  if (!document) throw notFound('That invoice does not exist, or is not yours to read.');

  const [lines, landlord, payTo] = await Promise.all([
    tx<LineRow[]>`
      select line_number, category, description, amount_minor::text,
             service_period_start::text, service_period_end::text,
             prorated, proration_numerator, proration_denominator,
             full_period_amount_minor::text
        from charge_lines
       where document_id = ${documentId}::uuid
       order by line_number
    `,
    tx<InvoiceLandlordRow[]>`
      select legal_name, trading_name, registration_number, vat_number,
             physical_address, phone, email::text, agent_name, agent_contact
        from organisation_profiles
       where organisation_id = ${organisationId}::uuid
    `,
    tx<PayToRow[]>`
      select bank_name, account_holder, account_number_last4, branch_code
        from bank_accounts
       where organisation_id = ${organisationId}::uuid
         and account_role = 'operating' and is_active and verified_at is not null
       order by created_at
       limit 1
    `,
  ]);

  return assemble(document, lines, landlord[0], payTo[0]);
}

/**
 * The same invoice, read by the person who owes it.
 *
 * The document and its lines come through the resident's own additive select
 * policies; who the landlord is and where to pay come through the functions
 * that check the portal link first. A lease that is not theirs yields nothing
 * at any step.
 */
export async function loadInvoiceForResident(
  tx: Sql, leaseId: string, documentId: string,
): Promise<InvoiceDocument> {
  const [document] = await tx<DocumentRow[]>`
    select d.id, d.document_number, d.document_type::text, d.status::text,
           d.issue_date::text, d.due_date::text, d.period_start::text, d.period_end::text,
           d.currency_code, d.total_minor::text, d.lease_id, d.reversed_by_document_id,
           l.reference as lease_reference,
           p.name as property_name, u.code as unit_code,
           p.address_line1, p.address_line2, p.suburb, p.city, p.province, p.postal_code,
           (rp.first_name || ' ' || rp.last_name) as resident_name,
           rp.email::text as resident_email
      from charge_documents d
      join leases l on l.id = d.lease_id
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp on lp.lease_id = l.id
        and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where d.id = ${documentId}::uuid and d.lease_id = ${leaseId}::uuid
  `;
  if (!document) throw notFound('That invoice does not exist, or is not yours to read.');

  const [lines, landlord, payTo] = await Promise.all([
    tx<LineRow[]>`
      select line_number, category, description, amount_minor::text,
             service_period_start::text, service_period_end::text,
             prorated, proration_numerator, proration_denominator,
             full_period_amount_minor::text
        from charge_lines
       where document_id = ${documentId}::uuid
       order by line_number
    `,
    tx<InvoiceLandlordRow[]>`
      select legal_name, trading_name, registration_number, vat_number,
             physical_address, phone, email, agent_name, agent_contact
        from app.resident_invoice_landlord(${leaseId}::uuid)
    `,
    tx<PayToRow[]>`
      select bank_name, account_holder, account_number_last4, branch_code
        from app.resident_payment_instructions(${leaseId}::uuid)
    `,
  ]);

  return assemble(document, lines, landlord[0], payTo[0]);
}

interface InvoiceLandlordRow {
  legal_name: string | null; trading_name: string | null;
  registration_number: string | null; vat_number: string | null;
  physical_address: string | null; phone: string | null; email: string | null;
  agent_name: string | null; agent_contact: string | null;
}

interface PayToRow {
  bank_name: string; account_holder: string; account_number_last4: string;
  branch_code: string | null;
}

function assemble(
  document: DocumentRow, lines: LineRow[],
  landlord: InvoiceLandlordRow | undefined, payTo: PayToRow | undefined,
): InvoiceDocument {
  return {
    documentId: document.id,
    documentNumber: document.document_number,
    documentType: document.document_type,
    status: document.status,
    issueDate: document.issue_date,
    dueDate: document.due_date,
    periodStart: document.period_start,
    periodEnd: document.period_end,
    currencyCode: document.currency_code,
    totalMinor: BigInt(document.total_minor),
    lines: toLines(lines),
    leaseReference: document.lease_reference,
    propertyName: document.property_name,
    unitCode: document.unit_code,
    propertyAddress: addressLines(document),
    residentName: document.resident_name ?? 'Resident',
    residentEmail: document.resident_email,
    landlord: {
      legalName: landlord?.legal_name ?? null,
      tradingName: landlord?.trading_name ?? null,
      registrationNumber: landlord?.registration_number ?? null,
      vatNumber: landlord?.vat_number ?? null,
      physicalAddress: landlord?.physical_address ?? null,
      phone: landlord?.phone ?? null,
      email: landlord?.email ?? null,
      agentName: landlord?.agent_name ?? null,
      agentContact: landlord?.agent_contact ?? null,
    },
    payTo: payTo
      ? {
        bankName: payTo.bank_name,
        accountHolder: payTo.account_holder,
        accountNumberLast4: payTo.account_number_last4,
        branchCode: payTo.branch_code,
      }
      : null,
    reversed: document.reversed_by_document_id !== null,
  };
}

export interface InvoiceSummary {
  documentId: string;
  documentNumber: string;
  documentType: string;
  issueDate: string;
  dueDate: string;
  totalMinor: Minor;
  currencyCode: string;
  reversed: boolean;
}

/**
 * The invoices on one lease, newest first, for the people who may see them.
 *
 * Used by the resident portal, so it returns only POSTED documents: a draft is
 * not in anybody's books and is not a demand, and showing a tenant a figure
 * that can still change is how an argument starts. Reversed invoices stay in
 * the list, marked, because a tenant who was sent one is entitled to find it
 * again and see that it was cancelled.
 *
 * Row-level security does the rest: a lease the caller cannot reach returns
 * nothing rather than erroring.
 */
export async function listInvoicesForLease(
  tx: Sql, leaseId: string, limit = 60,
): Promise<InvoiceSummary[]> {
  const rows = await tx<
    { id: string; document_number: string; document_type: string; issue_date: string;
      due_date: string; total_minor: string; currency_code: string;
      reversed_by_document_id: string | null }[]
  >`
    select id, document_number, document_type::text, issue_date::text, due_date::text,
           total_minor::text, currency_code, reversed_by_document_id
      from charge_documents
     where lease_id = ${leaseId}::uuid
       and status = 'posted'
       and document_type in ('rent_invoice', 'utility_invoice')
     order by issue_date desc, document_number desc
     limit ${limit}
  `;
  return rows.map((row) => ({
    documentId: row.id,
    documentNumber: row.document_number,
    documentType: row.document_type,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    totalMinor: BigInt(row.total_minor),
    currencyCode: row.currency_code,
    reversed: row.reversed_by_document_id !== null,
  }));
}
