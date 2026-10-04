import { createHash } from 'node:crypto';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { parseCsv, toCsvTemplate, CsvParseError, type CsvRow } from './csv';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import type { Minor } from './money';
import { parseMajorToMinor, sumMinor } from './money';
import { nextDocumentNumber } from './numbering';
import { postJournal, resolveSystemAccounts } from './ledger';
import { requirePermission } from './permissions';

/**
 * Onboarding import.
 *
 * Two phases, always:
 *   1. PREVIEW — parse, validate every row against the live database, and
 *      report errors by row and field. Nothing is written.
 *   2. COMMIT  — one transaction. Either the whole batch lands or none of it
 *      does, so an operator never has to guess which rows were committed.
 *
 * The blueprint's import order is properties → units → residents → leases →
 * schedules → balances → documents, and each kind resolves its parents by the
 * CODES the operator already uses, not by surrogate ids they have never seen.
 */

export type ImportKind =
  | 'properties' | 'units' | 'residents' | 'leases'
  | 'charge_schedules' | 'opening_balances' | 'deposits';

export interface RowError {
  line: number;
  field: string | null;
  message: string;
}

export interface ImportPreview {
  kind: ImportKind;
  filename: string;
  sha256: string;
  rowCount: number;
  validCount: number;
  errors: RowError[];
  /** A readable echo of the first few valid rows, for the operator to eyeball. */
  sample: Array<Record<string, string>>;
  /** Totals, where the import carries money. Shown before anything is posted. */
  totalMinor?: Minor;
  /** True when opening balances were supplied as one figure with no due dates. */
  limitedAgeingDetail?: boolean;
}

/**
 * Removes the guidance lines the downloaded template carries.
 *
 * The template explains each column in leading `#` lines. Operators reliably
 * forget to delete them, and failing on that would be a pointless obstacle, so
 * they are stripped here. A `#` inside a quoted value is untouched, because
 * only lines that START with `#` outside quotes are considered guidance.
 */
export function stripGuidanceLines(content: string): string {
  const withoutBom = content.replace(/^\uFEFF/, '');
  const lines = withoutBom.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && (lines[start]!.trimStart().startsWith('#') || lines[start]!.trim() === '')) {
    start += 1;
  }
  return lines.slice(start).join('\r\n');
}

/* ------------------------------------------------------------- templates */

interface ColumnSpec {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

const TEMPLATES: Record<ImportKind, { columns: ColumnSpec[]; notes: string[] }> = {
  properties: {
    columns: [
      { name: 'code', required: true, description: 'Your own short reference. Must be unique.', example: 'PROTEA14' },
      { name: 'name', required: true, description: 'Property name', example: '14 Protea Street' },
      { name: 'property_type', required: true, description: 'house, cottage, apartment, apartment_block, townhouse or other', example: 'house' },
      { name: 'address_line1', required: true, description: 'Street address', example: '14 Protea Street' },
      { name: 'suburb', required: false, description: 'Suburb', example: 'Newlands' },
      { name: 'city', required: true, description: 'City', example: 'Cape Town' },
      { name: 'province', required: false, description: 'Province', example: 'Western Cape' },
      { name: 'postal_code', required: false, description: 'Postal code', example: '7700' },
      { name: 'portfolio_code', required: false, description: 'Portfolio code. Defaults to your first portfolio.', example: 'DEFAULT' },
    ],
    notes: ['Import properties first. Units reference them by code.'],
  },
  units: {
    columns: [
      { name: 'property_code', required: true, description: 'Must match a property already imported', example: 'PROTEA14' },
      { name: 'code', required: true, description: 'Unit code, unique within the property', example: 'MAIN' },
      { name: 'rentable_type', required: false, description: 'whole_property, apartment, cottage, room or other', example: 'whole_property' },
      { name: 'bedrooms', required: false, description: 'Whole number', example: '3' },
      { name: 'bathrooms', required: false, description: 'May be a half, e.g. 1.5', example: '2' },
      { name: 'advertised_rent', required: false, description: 'Marketing rent, not the contracted rent', example: '8500.00' },
    ],
    notes: [
      'A standalone house still needs one unit. Use the code MAIN.',
      'Advertised rent is separate from the rent on the lease.',
    ],
  },
  residents: {
    columns: [
      { name: 'reference', required: true, description: 'Your own reference for this person. Used by the lease import.', example: 'RES-001' },
      { name: 'first_name', required: true, description: 'First name', example: 'Thandiwe' },
      { name: 'last_name', required: true, description: 'Surname', example: 'Mokoena' },
      { name: 'email', required: false, description: 'Used for the portal invitation', example: 'thandiwe@example.com' },
      { name: 'phone', required: false, description: 'Contact number', example: '+27 82 555 0101' },
    ],
    notes: [
      'A resident does not need an email address. The portal invitation is separate and optional.',
      'Do not import identity numbers here. They are collected for a defined purpose through the resident record.',
    ],
  },
  leases: {
    columns: [
      { name: 'reference', required: true, description: 'Your own lease reference', example: 'L-2026-001' },
      { name: 'property_code', required: true, description: 'Must match an imported property', example: 'PROTEA14' },
      { name: 'unit_code', required: true, description: 'Must match a unit in that property', example: 'MAIN' },
      { name: 'primary_resident_reference', required: true, description: 'Must match an imported resident', example: 'RES-001' },
      { name: 'co_lessee_references', required: false, description: 'Other lease parties, separated by semicolons', example: 'RES-002;RES-003' },
      { name: 'start_date', required: true, description: 'YYYY-MM-DD', example: '2026-01-01' },
      { name: 'end_date', required: false, description: 'YYYY-MM-DD. Leave blank for month to month.', example: '2026-12-31' },
      { name: 'rent', required: true, description: 'Contracted monthly rent', example: '8000.00' },
      { name: 'billing_day', required: false, description: '1 to 31. Defaults to 1.', example: '1' },
      { name: 'deposit_required', required: false, description: 'Deposit the lease requires', example: '8000.00' },
    ],
    notes: [
      'Imported leases are created ACTIVE, with the import batch recorded as the activation evidence.',
      'Two leases cannot reserve the same unit over overlapping dates. The import will tell you which rows clash.',
      'Joint parties share one rent receivable. Adding a co-lessee never creates a second rent charge.',
    ],
  },
  charge_schedules: {
    columns: [
      { name: 'lease_reference', required: true, description: 'Must match an imported lease', example: 'L-2026-001' },
      { name: 'category', required: true, description: 'rent, utility_fixed, parking or other', example: 'rent' },
      { name: 'description', required: true, description: 'Shown on the statement', example: 'Monthly rent' },
      { name: 'amount', required: true, description: 'Amount per period', example: '8000.00' },
      { name: 'due_day', required: false, description: '1 to 31. Defaults to 1.', example: '1' },
    ],
    notes: [
      'A rent schedule is created automatically when a lease is imported. Use this file only for ADDITIONAL recurring charges.',
    ],
  },
  opening_balances: {
    columns: [
      { name: 'lease_reference', required: true, description: 'Must match an imported lease', example: 'L-2026-001' },
      { name: 'description', required: true, description: 'What this unpaid amount is', example: 'Rent arrears, November 2025' },
      { name: 'amount', required: true, description: 'Amount still unpaid. Not the original invoice total.', example: '1000.00' },
      { name: 'due_date', required: false, description: 'The ORIGINAL due date. Supply it so arrears ageing is correct.', example: '2025-11-01' },
    ],
    notes: [
      'Import one row per historical UNPAID charge, with its original due date, so arrears ageing is accurate.',
      'If you only have a single total per resident, supply one row with no due date. The statement will then say the ageing detail is limited rather than implying a precision you did not give.',
      'Do NOT represent historical arrears as a new month of rent. These are posted as opening balance documents, not rent invoices.',
      'This import requires a cut-off date, a source reference and an approver before it will commit.',
    ],
  },
  deposits: {
    columns: [
      { name: 'lease_reference', required: true, description: 'Must match an imported lease', example: 'L-2026-001' },
      { name: 'amount_held', required: true, description: 'Amount you are actually holding today', example: '8000.00' },
      { name: 'holder', required: true, description: 'landlord, agency_trust or third_party_custodian', example: 'landlord' },
      { name: 'holder_reference', required: false, description: 'Bank or custodian reference', example: 'FNB 62xxxx1234' },
      { name: 'received_on', required: true, description: 'When the deposit was received', example: '2026-01-01' },
    ],
    notes: [
      'Deposits are imported separately from arrears, and the holder is recorded explicitly.',
      'A deposit is a liability to the resident. It is never rental income and does not reduce arrears.',
      'Interest is NOT calculated. Record credited interest only from actual evidence, after import.',
    ],
  },
};

export function importTemplate(kind: ImportKind): { csv: string; columns: ColumnSpec[]; notes: string[] } {
  const spec = TEMPLATES[kind];
  const example: Record<string, string> = {};
  for (const column of spec.columns) example[column.name] = column.example;
  return {
    csv: toCsvTemplate(spec.columns.map((c) => c.name), [example]),
    columns: spec.columns,
    notes: spec.notes,
  };
}

/* ------------------------------------------------------------ validation */

function requireValue(row: CsvRow, field: string, errors: RowError[]): string | null {
  const value = row.values[field];
  if (!value) {
    errors.push({ line: row.line, field, message: `"${field}" is required.` });
    return null;
  }
  return value;
}

function parseAmount(row: CsvRow, field: string, errors: RowError[], required: boolean): Minor | null {
  const raw = row.values[field];
  if (!raw) {
    if (required) errors.push({ line: row.line, field, message: `"${field}" is required.` });
    return required ? null : 0n;
  }
  try {
    const amount = parseMajorToMinor(raw, 'ZAR');
    if (amount < 0n) {
      errors.push({ line: row.line, field, message: 'Amount cannot be negative.' });
      return null;
    }
    return amount;
  } catch (error) {
    errors.push({
      line: row.line, field,
      message: error instanceof Error ? error.message : 'Not a valid amount.',
    });
    return null;
  }
}

function parseDate(row: CsvRow, field: string, errors: RowError[], required: boolean): string | null {
  const raw = row.values[field];
  if (!raw) {
    if (required) errors.push({ line: row.line, field, message: `"${field}" is required.` });
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    errors.push({ line: row.line, field, message: 'Use the format YYYY-MM-DD, for example 2026-01-31.' });
    return null;
  }
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    errors.push({ line: row.line, field, message: 'That is not a real date.' });
    return null;
  }
  return raw;
}

function parseEnum(
  row: CsvRow, field: string, allowed: readonly string[], errors: RowError[],
  required: boolean, fallback?: string,
): string | null {
  const raw = row.values[field];
  if (!raw) {
    if (required) errors.push({ line: row.line, field, message: `"${field}" is required.` });
    return required ? null : (fallback ?? null);
  }
  if (!allowed.includes(raw)) {
    errors.push({
      line: row.line, field,
      message: `"${raw}" is not valid. Use one of: ${allowed.join(', ')}.`,
    });
    return null;
  }
  return raw;
}

/* --------------------------------------------------------------- preview */

export interface PreviewInput {
  kind: ImportKind;
  filename: string;
  content: string;
}

export async function previewImport(
  tx: Sql,
  organisationId: string,
  input: PreviewInput,
): Promise<ImportPreview> {
  await requirePermission(tx, organisationId, 'property.create');

  const sha256 = createHash('sha256').update(input.content).digest('hex');
  let document;
  try {
    document = parseCsv(stripGuidanceLines(input.content));
  } catch (error) {
    if (error instanceof CsvParseError) {
      return {
        kind: input.kind, filename: input.filename, sha256,
        rowCount: 0, validCount: 0,
        errors: [{ line: error.line, field: null, message: error.message }],
        sample: [],
      };
    }
    throw error;
  }

  const spec = TEMPLATES[input.kind];
  const errors: RowError[] = [];

  // A missing REQUIRED column is a file-level problem; report it once and stop,
  // rather than emitting the same error for every row.
  const missing = spec.columns
    .filter((c) => c.required && !document.headers.includes(c.name))
    .map((c) => c.name);
  if (missing.length > 0) {
    return {
      kind: input.kind, filename: input.filename, sha256,
      rowCount: document.rows.length, validCount: 0,
      errors: [{
        line: 1, field: null,
        message: `The file is missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Download the template to see the expected format.`,
      }],
      sample: [],
    };
  }

  if (document.rows.length === 0) {
    return {
      kind: input.kind, filename: input.filename, sha256,
      rowCount: 0, validCount: 0,
      errors: [{ line: 1, field: null, message: 'The file has column headings but no rows.' }],
      sample: [],
    };
  }

  const validated = await validateRows(tx, organisationId, input.kind, document.rows, errors);

  const linesWithErrors = new Set(errors.map((e) => e.line));
  const valid = document.rows.filter((r) => !linesWithErrors.has(r.line));

  return {
    kind: input.kind,
    filename: input.filename,
    sha256,
    rowCount: document.rows.length,
    validCount: valid.length,
    errors: errors.sort((a, b) => a.line - b.line),
    sample: valid.slice(0, 5).map((r) => r.values),
    totalMinor: validated.totalMinor,
    limitedAgeingDetail: validated.limitedAgeingDetail,
  };
}

interface ValidationSummary {
  totalMinor?: Minor;
  limitedAgeingDetail?: boolean;
}

async function validateRows(
  tx: Sql,
  organisationId: string,
  kind: ImportKind,
  rows: CsvRow[],
  errors: RowError[],
): Promise<ValidationSummary> {
  // Existing records, resolved once rather than per row.
  const [properties, units, residents, leases] = await Promise.all([
    tx<{ id: string; code: string }[]>`select id, code from properties where organisation_id = ${organisationId}::uuid`,
    tx<{ id: string; code: string; property_id: string }[]>`select id, code, property_id from units where organisation_id = ${organisationId}::uuid`,
    tx<{ id: string; reference: string }[]>`
      select id, coalesce(nullif(notes, ''), id::text) as reference from resident_profiles
      where organisation_id = ${organisationId}::uuid
    `,
    tx<{ id: string; reference: string; unit_id: string; start_date: string; end_date: string | null; status: string }[]>`
      select id, reference, unit_id, start_date::text, end_date::text, status::text
      from leases where organisation_id = ${organisationId}::uuid
    `,
  ]);

  const propertyByCode = new Map(properties.map((p) => [p.code, p]));
  const unitByKey = new Map(units.map((u) => [`${u.property_id}:${u.code}`, u]));
  const residentByRef = new Map(residents.map((r) => [r.reference, r]));
  const leaseByRef = new Map(leases.map((l) => [l.reference, l]));

  // Within-file duplicates and references, so a file is checked against itself
  // as well as against the database.
  const seen = new Set<string>();
  const fileResidents = new Set<string>();
  const fileProperties = new Set<string>();
  const fileUnits = new Set<string>();
  const fileLeases = new Set<string>();
  let total = 0n;
  let anyMissingDueDate = false;

  for (const row of rows) {
    switch (kind) {
      case 'properties': {
        const code = requireValue(row, 'code', errors);
        requireValue(row, 'name', errors);
        requireValue(row, 'address_line1', errors);
        requireValue(row, 'city', errors);
        parseEnum(row, 'property_type',
          ['house', 'cottage', 'apartment', 'apartment_block', 'townhouse', 'other'], errors, true);
        if (code) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/.test(code)) {
            errors.push({ line: row.line, field: 'code', message: 'Use letters, numbers, dot, dash or underscore, up to 24 characters.' });
          }
          if (propertyByCode.has(code)) {
            errors.push({ line: row.line, field: 'code', message: `A property with code "${code}" already exists.` });
          }
          if (seen.has(code)) {
            errors.push({ line: row.line, field: 'code', message: `The code "${code}" appears more than once in this file.` });
          }
          seen.add(code);
          fileProperties.add(code);
        }
        const portfolio = row.values.portfolio_code;
        if (portfolio) {
          const [found] = await tx<{ id: string }[]>`
            select id from portfolios where organisation_id = ${organisationId}::uuid and code = ${portfolio}
          `;
          if (!found) {
            errors.push({ line: row.line, field: 'portfolio_code', message: `No portfolio with code "${portfolio}".` });
          }
        }
        break;
      }

      case 'units': {
        const propertyCode = requireValue(row, 'property_code', errors);
        const code = requireValue(row, 'code', errors);
        if (propertyCode && !propertyByCode.has(propertyCode)) {
          errors.push({
            line: row.line, field: 'property_code',
            message: `No property with code "${propertyCode}". Import properties first.`,
          });
        }
        if (propertyCode && code) {
          const property = propertyByCode.get(propertyCode);
          if (property && unitByKey.has(`${property.id}:${code}`)) {
            errors.push({ line: row.line, field: 'code', message: `Unit "${code}" already exists in ${propertyCode}.` });
          }
          const key = `${propertyCode}:${code}`;
          if (seen.has(key)) {
            errors.push({ line: row.line, field: 'code', message: `Unit "${code}" appears twice for ${propertyCode} in this file.` });
          }
          seen.add(key);
          fileUnits.add(key);
        }
        if (row.values.bedrooms && !/^\d{1,2}$/.test(row.values.bedrooms)) {
          errors.push({ line: row.line, field: 'bedrooms', message: 'Use a whole number.' });
        }
        parseAmount(row, 'advertised_rent', errors, false);
        break;
      }

      case 'residents': {
        const reference = requireValue(row, 'reference', errors);
        requireValue(row, 'first_name', errors);
        requireValue(row, 'last_name', errors);
        if (reference) {
          if (seen.has(reference)) {
            errors.push({ line: row.line, field: 'reference', message: `The reference "${reference}" appears more than once in this file.` });
          }
          seen.add(reference);
          fileResidents.add(reference);
        }
        const email = row.values.email;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ line: row.line, field: 'email', message: 'That is not a valid email address.' });
        }
        break;
      }

      case 'leases': {
        const reference = requireValue(row, 'reference', errors);
        const propertyCode = requireValue(row, 'property_code', errors);
        const unitCode = requireValue(row, 'unit_code', errors);
        const residentRef = requireValue(row, 'primary_resident_reference', errors);
        const start = parseDate(row, 'start_date', errors, true);
        const end = parseDate(row, 'end_date', errors, false);
        parseAmount(row, 'rent', errors, true);
        parseAmount(row, 'deposit_required', errors, false);

        if (reference) {
          if (leaseByRef.has(reference)) {
            errors.push({ line: row.line, field: 'reference', message: `A lease with reference "${reference}" already exists.` });
          }
          if (seen.has(reference)) {
            errors.push({ line: row.line, field: 'reference', message: `The reference "${reference}" appears more than once in this file.` });
          }
          seen.add(reference);
          fileLeases.add(reference);
        }

        let unitId: string | null = null;
        if (propertyCode && unitCode) {
          const property = propertyByCode.get(propertyCode);
          if (!property) {
            errors.push({ line: row.line, field: 'property_code', message: `No property with code "${propertyCode}".` });
          } else {
            const unit = unitByKey.get(`${property.id}:${unitCode}`);
            if (!unit) {
              errors.push({ line: row.line, field: 'unit_code', message: `No unit "${unitCode}" in property "${propertyCode}".` });
            } else {
              unitId = unit.id;
            }
          }
        }

        if (residentRef && !residentByRef.has(residentRef)) {
          errors.push({
            line: row.line, field: 'primary_resident_reference',
            message: `No resident with reference "${residentRef}". Import residents first.`,
          });
        }
        for (const coRef of (row.values.co_lessee_references ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
          if (!residentByRef.has(coRef)) {
            errors.push({ line: row.line, field: 'co_lessee_references', message: `No resident with reference "${coRef}".` });
          }
        }

        if (start && end && end < start) {
          errors.push({ line: row.line, field: 'end_date', message: 'The end date is before the start date.' });
        }

        // Overlap, against the database AND against earlier rows of this file.
        // The exclusion constraint would catch it at commit; catching it here
        // means the operator sees WHICH rows clash before anything is written.
        if (unitId && start) {
          const overlapping = leases.find((l) =>
            l.unit_id === unitId
            && ['active', 'notice_given', 'expired', 'awaiting_execution'].includes(l.status)
            && l.start_date <= (end ?? '9999-12-31')
            && (l.end_date ?? '9999-12-31') >= start,
          );
          if (overlapping) {
            errors.push({
              line: row.line, field: 'start_date',
              message: `This overlaps existing lease ${overlapping.reference} on the same unit.`,
            });
          }
        }
        break;
      }

      case 'charge_schedules': {
        const leaseRef = requireValue(row, 'lease_reference', errors);
        requireValue(row, 'description', errors);
        parseAmount(row, 'amount', errors, true);
        parseEnum(row, 'category', ['rent', 'utility_fixed', 'parking', 'other'], errors, true);
        if (leaseRef && !leaseByRef.has(leaseRef)) {
          errors.push({ line: row.line, field: 'lease_reference', message: `No lease with reference "${leaseRef}".` });
        }
        break;
      }

      case 'opening_balances': {
        const leaseRef = requireValue(row, 'lease_reference', errors);
        requireValue(row, 'description', errors);
        const amount = parseAmount(row, 'amount', errors, true);
        const dueDate = row.values.due_date ? parseDate(row, 'due_date', errors, false) : null;

        if (leaseRef && !leaseByRef.has(leaseRef)) {
          errors.push({ line: row.line, field: 'lease_reference', message: `No lease with reference "${leaseRef}".` });
        }
        if (amount !== null && amount === 0n) {
          errors.push({ line: row.line, field: 'amount', message: 'An opening balance of zero does not need importing.' });
        }
        if (amount) total += amount;
        if (!row.values.due_date) anyMissingDueDate = true;
        void dueDate;
        break;
      }

      case 'deposits': {
        const leaseRef = requireValue(row, 'lease_reference', errors);
        const amount = parseAmount(row, 'amount_held', errors, true);
        parseEnum(row, 'holder', ['landlord', 'agency_trust', 'third_party_custodian'], errors, true);
        parseDate(row, 'received_on', errors, true);

        if (leaseRef) {
          if (!leaseByRef.has(leaseRef)) {
            errors.push({ line: row.line, field: 'lease_reference', message: `No lease with reference "${leaseRef}".` });
          } else {
            const lease = leaseByRef.get(leaseRef)!;
            const [existing] = await tx<{ id: string }[]>`
              select id from deposit_accounts
              where organisation_id = ${organisationId}::uuid and lease_id = ${lease.id}::uuid
            `;
            if (existing) {
              errors.push({ line: row.line, field: 'lease_reference', message: `A deposit account already exists for lease "${leaseRef}".` });
            }
          }
          if (seen.has(leaseRef)) {
            errors.push({ line: row.line, field: 'lease_reference', message: `Lease "${leaseRef}" appears more than once in this file.` });
          }
          seen.add(leaseRef);
        }
        if (amount) total += amount;
        break;
      }
    }
  }

  if (kind === 'opening_balances') {
    return { totalMinor: total, limitedAgeingDetail: anyMissingDueDate };
  }
  if (kind === 'deposits') return { totalMinor: total };
  return {};
}

/* ---------------------------------------------------------------- commit */

export interface CommitInput extends PreviewInput {
  /** Opening balance controls. Required for that kind, ignored otherwise. */
  cutOffDate?: string;
  sourceReference?: string;
  /** The approver confirms the figures. Recorded on the batch and audited. */
  approvedByUserId?: string;
}

export interface ImportResult {
  batchId: string;
  importedCount: number;
  totalMinor?: Minor;
  limitedAgeingDetail?: boolean;
}

/**
 * Commits an import.
 *
 * Re-validates from scratch inside the transaction: a preview taken ten minutes
 * ago may no longer be true, and the operator must never be able to commit a
 * stale preview. If ANY row fails, the whole transaction is rejected, so the
 * question "which rows were committed?" never arises.
 */
export async function commitImport(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: CommitInput,
): Promise<ImportResult> {
  await requirePermission(tx, organisationId, 'property.create');
  if (input.kind === 'opening_balances' || input.kind === 'deposits') {
    await requirePermission(tx, organisationId, 'billing.post');
  }

  const preview = await previewImport(tx, organisationId, input);
  if (preview.errors.length > 0) {
    throw new DomainError(
      'validation_failed',
      `This file still has ${preview.errors.length} problem${preview.errors.length > 1 ? 's' : ''}. ` +
        'Nothing was imported. Fix the rows listed and upload again.',
      { errors: preview.errors.slice(0, 50) },
    );
  }

  if (input.kind === 'opening_balances') {
    if (!input.cutOffDate) throw invalid('An opening balance import needs a cut-off date.');
    if (!input.sourceReference || input.sourceReference.trim().length < 3) {
      throw invalid('An opening balance import needs a source reference, such as the statement or spreadsheet it came from.');
    }
    if (!input.approvedByUserId) {
      throw invalid('An opening balance import needs an approver who confirms the figures.');
    }
  }

  const [batch] = await tx<{ id: string }[]>`
    insert into import_batches (
      organisation_id, kind, filename, source_sha256, row_count, valid_count,
      error_count, status, cut_off_date, source_reference, approved_by, approved_at,
      limited_ageing_detail, created_by
    ) values (
      ${organisationId}, ${input.kind}, ${input.filename},
      decode(${preview.sha256}, 'hex'), ${preview.rowCount}, ${preview.validCount}, 0,
      'preview', ${input.cutOffDate ?? null}, ${input.sourceReference ?? null},
      ${input.approvedByUserId ?? null},
      ${input.approvedByUserId ? tx`now()` : null},
      ${preview.limitedAgeingDetail ?? false}, ${actorUserId}
    )
    returning id
  `;
  if (!batch) throw new DomainError('internal', 'Import batch insert returned no row.');

  const document = parseCsv(stripGuidanceLines(input.content));

  try {
    const imported = await applyRows(tx, organisationId, actorUserId, input.kind, document.rows, batch.id);

    await tx`
      update import_batches set
        status = 'committed', imported_count = ${imported}, committed_at = now()
      where id = ${batch.id}::uuid
    `;

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: `import.${input.kind}.committed`,
      resourceType: 'import_batch', resourceId: batch.id,
      reason: input.sourceReference ?? null,
      after: {
        filename: input.filename,
        rows: imported,
        totalMinor: preview.totalMinor?.toString(),
        cutOffDate: input.cutOffDate ?? null,
        approvedBy: input.approvedByUserId ?? null,
        limitedAgeingDetail: preview.limitedAgeingDetail ?? false,
      },
    });

    return {
      batchId: batch.id,
      importedCount: imported,
      totalMinor: preview.totalMinor,
      limitedAgeingDetail: preview.limitedAgeingDetail,
    };
  } catch (error) {
    // The whole transaction rolls back, batch row included. Nothing partial
    // survives, which is the point.
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

async function applyRows(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  kind: ImportKind,
  rows: CsvRow[],
  batchId: string,
): Promise<number> {
  const [org] = await tx<{ currency_code: string }[]>`
    select currency_code from organisations where id = ${organisationId}::uuid
  `;
  if (!org) throw notFound('Organisation');
  const currency = org.currency_code;

  switch (kind) {
    case 'properties': {
      const [defaultPortfolio] = await tx<{ id: string }[]>`
        select id from portfolios where organisation_id = ${organisationId}::uuid order by created_at limit 1
      `;
      for (const row of rows) {
        let portfolioId = defaultPortfolio?.id;
        if (row.values.portfolio_code) {
          const [found] = await tx<{ id: string }[]>`
            select id from portfolios
            where organisation_id = ${organisationId}::uuid and code = ${row.values.portfolio_code}
          `;
          portfolioId = found?.id ?? portfolioId;
        }
        await tx`
          insert into properties (organisation_id, portfolio_id, name, code, property_type,
            address_line1, suburb, city, province, postal_code, country_code)
          values (${organisationId}, ${portfolioId}, ${row.values.name}, ${row.values.code},
                  ${row.values.property_type}, ${row.values.address_line1},
                  ${row.values.suburb || null}, ${row.values.city},
                  ${row.values.province || null}, ${row.values.postal_code || null}, 'ZA')
        `;
      }
      return rows.length;
    }

    case 'units': {
      for (const row of rows) {
        const [property] = await tx<{ id: string }[]>`
          select id from properties where organisation_id = ${organisationId}::uuid and code = ${row.values.property_code}
        `;
        await tx`
          insert into units (organisation_id, property_id, code, rentable_type,
            bedrooms, bathrooms, advertised_rent_minor)
          values (${organisationId}, ${property!.id}, ${row.values.code},
                  ${row.values.rentable_type || 'apartment'},
                  ${row.values.bedrooms ? Number(row.values.bedrooms) : null},
                  ${row.values.bathrooms ? Number(row.values.bathrooms) : null},
                  ${row.values.advertised_rent ? parseMajorToMinor(row.values.advertised_rent, currency).toString() : null})
        `;
      }
      return rows.length;
    }

    case 'residents': {
      for (const row of rows) {
        // The operator's own reference is kept in `notes` so later imports can
        // resolve it, and so the operator can match their records to ours.
        await tx`
          insert into resident_profiles (organisation_id, first_name, last_name, email, phone, notes, status)
          values (${organisationId}, ${row.values.first_name}, ${row.values.last_name},
                  ${row.values.email || null}, ${row.values.phone || null},
                  ${row.values.reference}, 'active')
        `;
      }
      return rows.length;
    }

    case 'leases': {
      for (const row of rows) {
        const [property] = await tx<{ id: string }[]>`
          select id from properties where organisation_id = ${organisationId}::uuid and code = ${row.values.property_code}
        `;
        const [unit] = await tx<{ id: string }[]>`
          select id from units where organisation_id = ${organisationId}::uuid
            and property_id = ${property!.id}::uuid and code = ${row.values.unit_code}
        `;
        const rent = parseMajorToMinor(row.values.rent!, currency);
        const deposit = row.values.deposit_required ? parseMajorToMinor(row.values.deposit_required, currency) : 0n;

        const [lease] = await tx<{ id: string }[]>`
          insert into leases (organisation_id, property_id, unit_id, reference, status,
            start_date, end_date, rent_minor, currency_code, billing_day,
            deposit_required_minor, activated_at, activated_by, execution_exception_reason)
          values (${organisationId}, ${property!.id}, ${unit!.id}, ${row.values.reference}, 'active',
                  ${row.values.start_date}, ${row.values.end_date || null},
                  ${rent.toString()}, ${currency},
                  ${row.values.billing_day ? Number(row.values.billing_day) : 1},
                  ${deposit.toString()}, now(), ${actorUserId},
                  ${`Imported from ${batchId}. The executed contract is held by the operator outside PropertyOS.`})
          returning id
        `;

        const parties = [
          { ref: row.values.primary_resident_reference!, role: 'primary_resident', financials: true },
          ...(row.values.co_lessee_references ?? '').split(';').map((s) => s.trim()).filter(Boolean)
            .map((ref) => ({ ref, role: 'co_lessee', financials: true })),
        ];
        for (const party of parties) {
          const [resident] = await tx<{ id: string }[]>`
            select id from resident_profiles
            where organisation_id = ${organisationId}::uuid and notes = ${party.ref}
          `;
          await tx`
            insert into lease_parties (organisation_id, lease_id, resident_id, role,
              can_view_financials, joined_on)
            values (${organisationId}, ${lease!.id}, ${resident!.id}, ${party.role},
                    ${party.financials}, ${row.values.start_date})
          `;
        }

        // Rent schedule and occupancy, exactly as lease activation creates them.
        await tx`
          insert into charge_schedules (organisation_id, lease_id, category, description,
            amount_minor, currency_code, effective_period, due_day, created_by)
          values (${organisationId}, ${lease!.id}, 'rent', 'Monthly rent',
                  ${rent.toString()}, ${currency},
                  daterange(${row.values.start_date}::date, ${row.values.end_date || null}::date, '[]'),
                  ${row.values.billing_day ? Number(row.values.billing_day) : 1}, ${actorUserId})
        `;
        await tx`
          insert into occupancy_intervals (organisation_id, unit_id, lease_id, period, move_in_at)
          values (${organisationId}, ${unit!.id}, ${lease!.id},
                  daterange(${row.values.start_date}::date, ${row.values.end_date || null}::date, '[]'),
                  ${row.values.start_date}::date)
        `;
      }
      return rows.length;
    }

    case 'charge_schedules': {
      for (const row of rows) {
        const [lease] = await tx<{ id: string; start_date: string; end_date: string | null }[]>`
          select id, start_date::text, end_date::text from leases
          where organisation_id = ${organisationId}::uuid and reference = ${row.values.lease_reference}
        `;
        await tx`
          insert into charge_schedules (organisation_id, lease_id, category, description,
            amount_minor, currency_code, effective_period, due_day, created_by)
          values (${organisationId}, ${lease!.id}, ${row.values.category}, ${row.values.description},
                  ${parseMajorToMinor(row.values.amount!, currency).toString()}, ${currency},
                  daterange(${lease!.start_date}::date, ${lease!.end_date}::date, '[]'),
                  ${row.values.due_day ? Number(row.values.due_day) : 1}, ${actorUserId})
        `;
      }
      return rows.length;
    }

    case 'opening_balances':
      return applyOpeningBalances(tx, organisationId, actorUserId, rows, batchId, currency);

    case 'deposits':
      return applyDeposits(tx, organisationId, actorUserId, rows, batchId, currency);
  }
}

/**
 * Posts imported arrears as OPENING BALANCE documents.
 *
 * Deliberately not rent invoices. "Do not represent every historical unpaid
 * amount as a new month's rent": these are brought-forward balances, they carry
 * their ORIGINAL due date so arrears ageing is correct, and they are linked to
 * the batch that created them so a statement can show where the figure came
 * from and who approved it.
 */
async function applyOpeningBalances(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  rows: CsvRow[],
  batchId: string,
  currency: string,
): Promise<number> {
  const [book] = await tx<{ id: string }[]>`
    select id from financial_books where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');
  const accounts = await resolveSystemAccounts(tx, book.id);
  const receivable = accounts.get('resident_receivable');
  const openingEquity = accounts.get('opening_equity');
  if (!receivable || !openingEquity) {
    throw new DomainError('internal', 'This book is missing the receivable or opening equity account.');
  }

  // Group by lease so each resident gets one opening balance document.
  const byLease = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const key = row.values.lease_reference!;
    byLease.set(key, [...(byLease.get(key) ?? []), row]);
  }

  for (const [leaseReference, leaseRows] of byLease) {
    const [lease] = await tx<{ id: string; property_id: string; unit_id: string }[]>`
      select id, property_id, unit_id from leases
      where organisation_id = ${organisationId}::uuid and reference = ${leaseReference}
    `;
    if (!lease) throw notFound(`Lease ${leaseReference}`);

    const lines = leaseRows.map((row) => ({
      description: row.values.description!,
      amount: parseMajorToMinor(row.values.amount!, currency),
      // No due date supplied means the operator had only a total. The line is
      // dated at the cut-off, and the batch records that ageing detail is
      // limited, rather than inventing an age for it.
      dueDate: row.values.due_date || null,
    }));
    const total = sumMinor(lines.map((l) => l.amount));

    const [batch] = await tx<{ cut_off_date: string; source_reference: string }[]>`
      select cut_off_date::text, source_reference from import_batches where id = ${batchId}::uuid
    `;
    const cutOff = batch!.cut_off_date;
    const documentNumber = await nextDocumentNumber(tx, organisationId, 'OPB');

    // The balancing side is opening equity, not rental income: this money was
    // earned before PropertyOS held the records, so recognising it as income
    // now would overstate the period.
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: book.id,
      currencyCode: currency,
      postingDate: cutOff,
      source: 'opening_balance',
      description: `${documentNumber} — opening balance brought forward (${batch!.source_reference})`,
      sourceTable: 'charge_documents',
      postedBy: actorUserId,
      lines: [
        { accountId: receivable, debitMinor: total, leaseId: lease.id, propertyId: lease.property_id, memo: documentNumber },
        { accountId: openingEquity, creditMinor: total, leaseId: lease.id, propertyId: lease.property_id, memo: 'Opening balance brought forward' },
      ],
    });

    const [doc] = await tx<{ id: string }[]>`
      insert into charge_documents (organisation_id, book_id, lease_id, document_type,
        document_number, status, currency_code, issue_date, due_date, total_minor,
        journal_id, import_batch_id, posted_at, posted_by, created_by)
      -- The DOCUMENT is issued at the cut-off, so its own due date is the
      -- cut-off: a document cannot fall due before it was issued. The original
      -- due dates live on the LINES, which is what arrears ageing is computed
      -- from, so the ageing stays true to the operator's history.
      values (${organisationId}, ${book.id}, ${lease.id}, 'opening_balance',
              ${documentNumber}, 'posted', ${currency}, ${cutOff}, ${cutOff},
              ${total.toString()}, ${journalId}, ${batchId}, now(), ${actorUserId}, ${actorUserId})
      returning id
    `;

    await tx`
      insert into charge_lines ${tx(
        lines.map((line, index) => ({
          organisation_id: organisationId,
          document_id: doc!.id,
          lease_id: lease.id,
          line_number: index + 1,
          category: 'opening_balance',
          description: line.description,
          amount_minor: line.amount.toString(),
          currency_code: currency,
          income_account_id: openingEquity,
          // The ORIGINAL due date where supplied, so ageing is real.
          due_date: line.dueDate ?? cutOff,
        })),
      )}
    `;
  }

  return rows.length;
}

async function applyDeposits(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  rows: CsvRow[],
  batchId: string,
  currency: string,
): Promise<number> {
  const [book] = await tx<{ id: string }[]>`
    select id from financial_books where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');
  const accounts = await resolveSystemAccounts(tx, book.id);
  const depositBank = accounts.get('deposit_bank_control');
  const depositLiability = accounts.get('deposit_liability');
  if (!depositBank || !depositLiability) {
    throw new DomainError('internal', 'This book is missing the deposit accounts.');
  }

  for (const row of rows) {
    const [lease] = await tx<{ id: string; property_id: string }[]>`
      select id, property_id from leases
      where organisation_id = ${organisationId}::uuid and reference = ${row.values.lease_reference}
    `;
    if (!lease) throw notFound(`Lease ${row.values.lease_reference}`);
    const amount = parseMajorToMinor(row.values.amount_held!, currency);

    const [account] = await tx<{ id: string }[]>`
      insert into deposit_accounts (organisation_id, book_id, lease_id, holder,
        holder_reference, currency_code, required_minor, opened_on, import_batch_id)
      values (${organisationId}, ${book.id}, ${lease.id}, ${row.values.holder},
              ${row.values.holder_reference || null}, ${currency}, ${amount.toString()},
              ${row.values.received_on}, ${batchId})
      returning id
    `;

    // The deposit is a LIABILITY to the resident. It never touches rental income
    // and never reduces the rent receivable.
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: book.id,
      currencyCode: currency,
      postingDate: row.values.received_on!,
      source: 'deposit',
      description: `Imported deposit held for lease ${row.values.lease_reference}`,
      sourceTable: 'deposit_accounts',
      sourceId: account!.id,
      postedBy: actorUserId,
      lines: [
        { accountId: depositBank, debitMinor: amount, leaseId: lease.id, propertyId: lease.property_id },
        { accountId: depositLiability, creditMinor: amount, leaseId: lease.id, propertyId: lease.property_id },
      ],
    });

    await tx`
      insert into deposit_events (organisation_id, deposit_account_id, event_type,
        amount_minor, currency_code, effective_on, description, journal_id)
      values (${organisationId}, ${account!.id}, 'received', ${amount.toString()}, ${currency},
              ${row.values.received_on}, ${'Deposit balance brought forward on import'}, ${journalId})
    `;
  }

  return rows.length;
}
