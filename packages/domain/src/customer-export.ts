import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { requirePermission } from './permissions';
import { buildZip } from './zip';

/**
 * The customer's own data, in a form they can leave with.
 *
 * §24 asks for a documented export of properties, units, parties, leases,
 * charges, receipts, allocations, deposits and expenses, with an attachment
 * manifest. The point of it is leverage: a customer who cannot get their
 * tenancy history out is not a customer, they are a hostage, and the
 * difference shows up on the day they want to leave rather than on the day
 * they sign.
 *
 * Three decisions worth stating, because each one is a thing the export
 * deliberately does NOT do:
 *
 *  1. **It is read as the person asking.** Every query runs inside their
 *     transaction, so Row Level Security scopes it exactly as the screens do.
 *     A property-scoped manager exports their properties, not the portfolio.
 *     Nothing here reaches for a privileged connection to "make the export
 *     complete", because an export that returns more than the screens would is
 *     a way around the permission model rather than a feature.
 *  2. **Sealed numbers stay sealed.** An identity number and a bank account
 *     number are readable in this product only through a narrow, audited,
 *     permission-gated path that records who looked. A bulk file that anybody
 *     with the export permission could take is not that path, so the export
 *     carries the last four digits, exactly as the screens do.
 *  3. **Document bytes are not in it.** The manifest names every attachment
 *     with its storage key and SHA-256 so the files can be matched to an object
 *     backup, but the objects live in private storage with their own
 *     authorisation and quarantine rules, and an archive is not a way around
 *     those. The README says so, so nobody mistakes a complete manifest for
 *     complete files.
 *
 * The whole archive is built in memory. That bounds it to what the process can
 * hold, which is honest for the size of portfolio this product is for and is
 * said out loud rather than discovered.
 */

export interface CustomerExport {
  filename: string;
  bytes: Buffer;
  /** Row counts per file, for the audit entry and the screen. */
  counts: Record<string, number>;
}

/** RFC 4180 for a plain table: a header row, then the rows. */
function tableCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown) => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** One exported file: what it is called, what it holds, and how it is read. */
interface Table {
  file: string;
  description: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export async function buildCustomerExport(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
): Promise<CustomerExport> {
  await requirePermission(tx, organisationId, 'customer.export');

  const [organisation] = await tx<{ name: string; slug: string }[]>`
    select name, slug from organisations where id = ${organisationId}::uuid
  `;
  if (!organisation) {
    // RLS, not a missing row: a caller who cannot see the organisation cannot
    // export it either.
    throw new Error('The organisation could not be read.');
  }

  const tables: Table[] = [
    {
      file: 'portfolios.csv',
      description: 'Portfolios, the grouping above a property.',
      columns: ['id', 'name', 'code', 'created_at'],
      rows: await tx`
        select id, name, code, created_at::text
          from portfolios where organisation_id = ${organisationId}::uuid order by code
      `,
    },
    {
      file: 'properties.csv',
      description: 'Properties, with the address as captured.',
      columns: [
        'id', 'portfolio_id', 'code', 'name', 'property_type', 'status',
        'address_line1', 'address_line2', 'suburb', 'city', 'province',
        'postal_code', 'country_code', 'municipal_account_ref', 'created_at',
      ],
      rows: await tx`
        select id, portfolio_id, code, name, property_type::text, status::text,
               address_line1, address_line2, suburb, city, province,
               postal_code, country_code, municipal_account_ref, created_at::text
          from properties where organisation_id = ${organisationId}::uuid order by code
      `,
    },
    {
      file: 'units.csv',
      description: 'Units within a property. advertised_rent_minor is a marketing figure, never what a lease charges.',
      columns: [
        'id', 'property_id', 'code', 'description', 'rentable_type', 'bedrooms',
        'bathrooms', 'floor', 'floor_area_sqm', 'advertised_rent_minor', 'status', 'created_at',
      ],
      rows: await tx`
        select id, property_id, code, description, rentable_type::text, bedrooms,
               bathrooms, floor, floor_area_sqm, advertised_rent_minor::text,
               status::text, created_at::text
          from units where organisation_id = ${organisationId}::uuid order by property_id, code
      `,
    },
    {
      file: 'residents.csv',
      description:
        'The people. identity_number_last4 only: the full number is sealed and is readable ' +
        'in the product through an audited path, not through a file.',
      columns: [
        'id', 'first_name', 'last_name', 'email', 'phone', 'identity_number_last4',
        'date_of_birth', 'status', 'communication_preference', 'created_at',
      ],
      rows: await tx`
        select id, first_name, last_name, email::text, phone, identity_number_last4,
               date_of_birth::text, status::text, communication_preference::text, created_at::text
          from resident_profiles where organisation_id = ${organisationId}::uuid
         order by last_name, first_name
      `,
    },
    {
      file: 'lease_parties.csv',
      description: 'Who is on which lease, in what role, and whether they may see the money.',
      columns: ['id', 'lease_id', 'resident_id', 'role', 'can_view_financials', 'joined_on', 'removed_on'],
      rows: await tx`
        select id, lease_id, resident_id, role::text, can_view_financials,
               joined_on::text, removed_on::text
          from lease_parties where organisation_id = ${organisationId}::uuid order by lease_id, role
      `,
    },
    {
      file: 'leases.csv',
      description: 'Leases, including closed and superseded ones. rent_minor is what the lease charges.',
      columns: [
        'id', 'reference', 'property_id', 'unit_id', 'status', 'start_date', 'end_date',
        'rent_minor', 'currency_code', 'billing_day', 'deposit_required_minor',
        'escalation_percent', 'escalation_month_interval', 'notice_days',
        'supersedes_lease_id', 'executed_at', 'activated_at', 'closed_at',
        'cancellation_reason', 'created_at',
      ],
      rows: await tx`
        select id, reference, property_id, unit_id, status::text, start_date::text, end_date::text,
               rent_minor::text, currency_code, billing_day, deposit_required_minor::text,
               escalation_percent::text, escalation_month_interval, notice_days,
               supersedes_lease_id, executed_at::text, activated_at::text, closed_at::text,
               cancellation_reason, created_at::text
          from leases where organisation_id = ${organisationId}::uuid order by reference
      `,
    },
    {
      file: 'charge_documents.csv',
      description: 'Invoices and credit notes. Only a posted document has an accounting effect.',
      columns: [
        'id', 'lease_id', 'document_type', 'document_number', 'status', 'currency_code',
        'issue_date', 'due_date', 'period_start', 'period_end', 'total_minor',
        'corrects_document_id', 'correction_reason', 'reversed_by_document_id',
        'disputed', 'posted_at', 'created_at',
      ],
      rows: await tx`
        select id, lease_id, document_type::text, document_number, status::text, currency_code,
               issue_date::text, due_date::text, period_start::text, period_end::text,
               total_minor::text, corrects_document_id, correction_reason,
               reversed_by_document_id, disputed, posted_at::text, created_at::text
          from charge_documents where organisation_id = ${organisationId}::uuid
         order by issue_date, document_number
      `,
    },
    {
      file: 'charge_lines.csv',
      description: 'The lines of each charge document: what was charged, for what period.',
      columns: [
        'id', 'document_id', 'lease_id', 'line_number', 'category', 'description',
        'amount_minor', 'currency_code', 'prorated', 'full_period_amount_minor',
        'service_period_start', 'service_period_end', 'due_date',
      ],
      rows: await tx`
        select id, document_id, lease_id, line_number, category::text, description,
               amount_minor::text, currency_code, prorated, full_period_amount_minor::text,
               service_period_start::text, service_period_end::text, due_date::text
          from charge_lines where organisation_id = ${organisationId}::uuid
         order by document_id, line_number
      `,
    },
    {
      file: 'receipts.csv',
      description: 'Money received, as recorded by a person who saw it in the account.',
      columns: [
        'id', 'lease_id', 'receipt_number', 'status', 'amount_minor', 'fee_minor',
        'currency_code', 'received_on', 'method', 'payer_reference', 'in_suspense',
        'reversal_of_receipt_id', 'confirmed_at', 'notes', 'created_at',
      ],
      rows: await tx`
        select id, lease_id, receipt_number, status::text, amount_minor::text, fee_minor::text,
               currency_code, received_on::text, method::text, payer_reference, in_suspense,
               reversal_of_receipt_id, confirmed_at::text, notes, created_at::text
          from receipts where organisation_id = ${organisationId}::uuid
         order by received_on, receipt_number
      `,
    },
    {
      file: 'payment_allocations.csv',
      description:
        'Which receipt paid which charge line. A reversed allocation keeps its row and carries ' +
        'reversed_at — the history is appended to, never rewritten.',
      columns: [
        'id', 'receipt_id', 'charge_line_id', 'amount_minor', 'currency_code',
        'applied_policy', 'allocated_on', 'reversed_on', 'reversal_reason',
      ],
      rows: await tx`
        select id, receipt_id, charge_line_id, amount_minor::text, currency_code,
               applied_policy::text, allocated_on::text, reversed_on::text, reversal_reason
          from payment_allocations where organisation_id = ${organisationId}::uuid
         order by receipt_id, allocated_on
      `,
    },
    {
      file: 'deposit_accounts.csv',
      description: 'Deposits held per lease. This money belongs to the resident and is never rental income.',
      columns: [
        'id', 'lease_id', 'holder', 'holder_reference', 'bank_reference', 'currency_code',
        'required_minor', 'status', 'interest_basis', 'opened_on', 'closed_on',
      ],
      rows: await tx`
        select id, lease_id, holder::text, holder_reference, bank_reference, currency_code,
               required_minor::text, status, interest_basis, opened_on::text, closed_on::text
          from deposit_accounts where organisation_id = ${organisationId}::uuid order by opened_on
      `,
    },
    {
      file: 'deposit_events.csv',
      description:
        'Every movement of deposit money, with who asked and who approved. Append-only: a ' +
        'mistake is corrected by a further entry.',
      columns: [
        'id', 'deposit_account_id', 'event_type', 'amount_minor', 'currency_code',
        'effective_on', 'description', 'evidence_document_id', 'requested_by',
        'requested_at', 'approved_by', 'approved_at', 'approval_reason', 'refund_reference',
      ],
      rows: await tx`
        select id, deposit_account_id, event_type::text, amount_minor::text, currency_code,
               effective_on::text, description, evidence_document_id, requested_by,
               requested_at::text, approved_by, approved_at::text, approval_reason, refund_reference
          from deposit_events where organisation_id = ${organisationId}::uuid
         order by deposit_account_id, effective_on
      `,
    },
    {
      file: 'expenses.csv',
      description: 'Costs against a property, draft through paid.',
      columns: [
        'id', 'property_id', 'vendor_id', 'category', 'cost_class', 'description',
        'amount_minor', 'currency_code', 'expense_date', 'invoice_reference',
        'invoice_document_id', 'status', 'approved_at', 'created_at',
      ],
      rows: await tx`
        select id, property_id, vendor_id, category, cost_class, description,
               amount_minor::text, currency_code, expense_date::text, invoice_reference,
               invoice_document_id, status, approved_at::text, created_at::text
          from expenses where organisation_id = ${organisationId}::uuid order by expense_date
      `,
    },
    {
      file: 'vendors.csv',
      description: 'Suppliers and contractors referenced by expenses and work orders.',
      columns: ['id', 'name', 'category', 'email', 'phone', 'created_at'],
      rows: await tx`
        select id, name, category, email::text, phone, created_at::text
          from vendors where organisation_id = ${organisationId}::uuid order by name
      `,
    },
    {
      file: 'attachments.csv',
      description:
        'The attachment manifest. Every document this organisation holds, with the storage key ' +
        'and SHA-256 needed to match it to the object backup. The bytes are NOT in this archive.',
      columns: [
        'id', 'title', 'classification', 'content_type', 'byte_size', 'sha256',
        'storage_bucket', 'storage_key', 'visibility', 'scan_status', 'quarantined',
        'property_id', 'lease_id', 'resident_id', 'version', 'supersedes_document_id',
        'uploaded_at', 'deleted_at',
      ],
      rows: await tx`
        select id, title, classification, content_type, byte_size::text,
               encode(content_sha256, 'hex') as sha256,
               storage_bucket, storage_key, visibility::text, scan_status::text, quarantined,
               property_id, lease_id, resident_id, version, supersedes_document_id,
               uploaded_at::text, deleted_at::text
          from documents where organisation_id = ${organisationId}::uuid order by uploaded_at
      `,
    },
  ];

  const generatedAt = new Date();
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table.file] = table.rows.length;

  const readme = [
    `Spike PropertyOS — data export`,
    `Organisation: ${organisation.name}`,
    `Generated at: ${generatedAt.toISOString()}`,
    '',
    'WHAT THIS IS',
    '',
    'Every record this organisation holds in PropertyOS, as RFC 4180 CSV files, one',
    'per kind of record. Identifiers are UUIDs and are stable across files, so the',
    'files join to each other: a charge line names its document, a document names',
    'its lease, a lease names its unit and property.',
    '',
    'MONEY',
    '',
    'Every amount ending in _minor is an INTEGER number of minor units — cents for',
    'ZAR. 185000 is R1,850.00. There are no fractional cents and no floating point',
    'anywhere in this product, which is why the figures are written this way rather',
    'than as decimals that a spreadsheet would round.',
    '',
    'DATES AND TIMES',
    '',
    'Dates are ISO (yyyy-mm-dd). Timestamps are ISO 8601 with an offset.',
    '',
    'WHAT IS DELIBERATELY NOT HERE',
    '',
    '  * Document bytes. attachments.csv names every file with its storage key and',
    '    SHA-256 so it can be matched to the object store, but the objects are held',
    '    privately with their own authorisation and quarantine rules, and an archive',
    '    is not a way around those. A complete manifest is not complete files.',
    '  * Full identity numbers and full bank account numbers. They are sealed at',
    '    rest and are readable in the product only through a narrow, audited path',
    '    that records who looked. The last four digits are here, as on the screens.',
    '  * Anything outside what the person who ran this export can see. The export is',
    '    read with their own permissions, so a property-scoped manager exports their',
    '    properties rather than the whole portfolio.',
    '  * Other organisations. Nothing in this file belongs to anybody else.',
    '',
    'FILES',
    '',
    ...tables.map((t) => `  ${t.file.padEnd(24)} ${counts[t.file]} row(s) — ${t.description}`),
    '',
    'This export was recorded in the audit history, with who ran it and when.',
    '',
  ].join('\n');

  const bytes = buildZip([
    { name: 'README.txt', content: readme, modified: generatedAt },
    ...tables.map((t) => ({
      name: t.file,
      content: tableCsv(t.rows, t.columns),
      modified: generatedAt,
    })),
  ]);

  await recordAudit(tx, {
    organisationId,
    actorUserId,
    action: 'customer.exported',
    resourceType: 'organisation',
    resourceId: organisationId,
    // Counts, not content: the audit entry says what left and how much of it,
    // and holds none of the data itself.
    after: { counts, byteSize: bytes.length },
  });

  const stamp = generatedAt.toISOString().slice(0, 10);
  return { filename: `propertyos-${organisation.slug}-${stamp}.zip`, bytes, counts };
}
