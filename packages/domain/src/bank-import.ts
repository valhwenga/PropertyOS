import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { parseCsv, CsvParseError } from './csv';
import { DomainError, fromDatabaseError, invalid, notFound, parsed } from './errors';
import { parseMajorToMinor, type Minor } from './money';
import { requirePermission } from './permissions';

/**
 * Importing a bank statement.
 *
 * The tables have existed since the schema was written — `bank_imports`,
 * `bank_transactions`, and two unique indexes to stop an overlapping statement
 * being imported twice — and nothing could write a row to either. So the one
 * thing a landlord actually does every month, sit down with the bank statement
 * and work out who paid, had no support at all.
 *
 * Two rules the whole module is built around.
 *
 * **A line on a bank statement is not a receipt.** It is evidence that money
 * arrived. Who it came from is a judgement somebody makes, and this module
 * never makes it: importing writes no receipt, posts no journal and touches no
 * resident's balance. The same rule as an uploaded proof of payment, applied
 * at the other end of the same problem.
 *
 * **No bank is ever contacted.** This reads a file the operator exported from
 * their own banking site. There is no feed, no provider, no credentials and no
 * screen-scraping, and nothing here should be described as a bank integration.
 */

/** A row as the operator's file has it, before anything is decided about it. */
export interface StatementRow {
  /** 1-based line in the source file, including the header. */
  line: number;
  transactionDate: string;
  description: string;
  amountMinor: Minor;
  externalId: string | null;
}

export type RowVerdict =
  /** Not seen before on this account. Importing will create it. */
  | 'new'
  /** Already imported, by the bank's own identifier or by fingerprint. */
  | 'already_imported'
  /** Cannot be read. Nothing is imported from this row and it is reported. */
  | 'unreadable';

export interface PreviewedRow extends Partial<StatementRow> {
  line: number;
  verdict: RowVerdict;
  /** Why it is unreadable, in the operator's terms, naming their own row. */
  problem?: string;
  fingerprint?: string;
}

export interface StatementPreview {
  bankAccountId: string;
  rows: PreviewedRow[];
  newCount: number;
  duplicateCount: number;
  unreadableCount: number;
  /** Credits only: money in. Sum of positive amounts among the new rows. */
  creditsMinor: Minor;
  /** Debits only: money out. Sum of negative amounts among the new rows. */
  debitsMinor: Minor;
  statementStart: string | null;
  statementEnd: string | null;
  sourceSha256: string;
  /** True when this exact file has already been committed on this account. */
  sameFileAlreadyImported: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reading the file                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The headers this understands.
 *
 * Deliberately a small, documented set rather than a parser per bank. A
 * bank-specific format guessed from memory is worse than one the operator can
 * see and conform to, and every South African bank's site can export a CSV
 * with a date, a description and an amount in it.
 *
 * `amount` may be signed, or `debit` and `credit` may be separate columns.
 */
const DATE_KEYS = ['date', 'transaction date', 'transactiondate', 'posting date', 'value date'];
const DESCRIPTION_KEYS = ['description', 'details', 'narrative', 'reference', 'memo'];
const AMOUNT_KEYS = ['amount', 'value'];
const DEBIT_KEYS = ['debit', 'debit amount', 'money out', 'withdrawal'];
const CREDIT_KEYS = ['credit', 'credit amount', 'money in', 'deposit'];
const ID_KEYS = ['id', 'transaction id', 'transactionid', 'external id', 'bank reference'];

export const STATEMENT_COLUMNS = {
  date: DATE_KEYS,
  description: DESCRIPTION_KEYS,
  amount: AMOUNT_KEYS,
  debit: DEBIT_KEYS,
  credit: CREDIT_KEYS,
  externalId: ID_KEYS,
} as const;

function pick(values: Record<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = Object.entries(values).find(([header]) => header.trim().toLowerCase() === key);
    if (found && found[1].trim() !== '') return found[1].trim();
  }
  return undefined;
}

/**
 * Normalises a date an operator's bank wrote.
 *
 * Accepts ISO, and day-first with any of `/.-` as the separator, because that
 * is what South African banks export and an operator cannot be asked to
 * rewrite their own file. A two-digit year is REFUSED rather than guessed: a
 * statement line in the wrong century lands in the wrong period and nobody
 * notices until the month will not reconcile.
 */
export function normaliseStatementDate(raw: string): string | undefined {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    const day = Number(d);
    const month = Number(m);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return undefined;
}

/**
 * Reads an amount the way a bank writes one.
 *
 * Thousands separators, a trailing or leading minus, and brackets for a
 * negative are all common. `currencyCode` decides the number of minor units,
 * so this never assumes two.
 */
export function parseStatementAmount(raw: string, currencyCode: string): Minor | undefined {
  let text = raw.trim().replace(/\s/g, '').replace(/[A-Za-z]/g, '').replace(/,/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }
  if (text.startsWith('+')) text = text.slice(1);
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;

  try {
    const minor = parseMajorToMinor(text, currencyCode);
    return negative ? -minor : minor;
  } catch {
    return undefined;
  }
}

/**
 * The fingerprint for a statement line, used only when the bank gives no id.
 *
 * The occurrence number is what makes this safe in both directions. Two
 * genuinely separate R500 payments from the same payer on the same day are
 * different lines and both must survive; the same line appearing in two
 * overlapping statements is one line and must not be imported twice. The
 * occurrence is counted across what is ALREADY on the account plus the rows
 * before this one in the file, so re-importing an overlapping month assigns
 * each line the number it had the first time.
 */
export function statementFingerprint(
  bankAccountId: string,
  row: { transactionDate: string; description: string; amountMinor: Minor },
  occurrence: number,
): string {
  return createHash('sha256')
    .update([
      bankAccountId,
      row.transactionDate,
      row.description.trim().replace(/\s+/g, ' ').toLowerCase(),
      row.amountMinor.toString(),
      String(occurrence),
    ].join('\u0000'))
    .digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

async function accountFor(tx: Sql, organisationId: string, bankAccountId: string) {
  const [account] = await tx<
    { id: string; bank_name: string; currency_code: string; is_active: boolean }[]
  >`
    select id, bank_name, currency_code, is_active
      from bank_accounts
     where id = ${bankAccountId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!account) throw notFound('Bank account');
  if (!account.is_active) {
    throw new DomainError(
      'conflict',
      'That bank account is no longer active. Statements are imported against the account '
        + 'they came from, so reactivate it or choose another.',
    );
  }
  return account;
}

/**
 * Classifies every row without writing anything.
 *
 * Read-only on purpose. An operator should see what an import will and will
 * not do before it does it, and a preview that writes is not a preview.
 */
export async function previewStatementImport(
  tx: Sql,
  organisationId: string,
  input: { bankAccountId: string; csv: string },
): Promise<StatementPreview> {
  await requirePermission(tx, organisationId, 'bank.import');
  const account = await accountFor(tx, organisationId, input.bankAccountId);

  const sourceSha256 = createHash('sha256').update(input.csv).digest('hex');

  let document;
  try {
    document = parseCsv(input.csv);
  } catch (error) {
    if (error instanceof CsvParseError) {
      throw invalid(`The file could not be read at line ${error.line}: ${error.message}`);
    }
    throw error;
  }

  if (document.rows.length === 0) {
    throw invalid('That file has a header and no rows. Nothing would be imported.');
  }

  const hasDate = DATE_KEYS.some((k) => document.headers.some((h) => h.trim().toLowerCase() === k));
  if (!hasDate) {
    throw invalid(
      'No date column. The file needs a column called one of: '
        + `${DATE_KEYS.join(', ')}. The headers found were: ${document.headers.join(', ')}.`,
    );
  }

  const [sameFile] = await tx<{ id: string }[]>`
    select id from bank_imports
     where bank_account_id = ${input.bankAccountId}::uuid
       and organisation_id = ${organisationId}::uuid
       and source_sha256 = decode(${sourceSha256}, 'hex')
       and status = 'committed'
  `;

  const rows: PreviewedRow[] = [];
  // Occurrences seen so far in THIS file, per identical line.
  const seenInFile = new Map<string, number>();
  let newCount = 0;
  let duplicateCount = 0;
  let unreadableCount = 0;
  let creditsMinor = 0n;
  let debitsMinor = 0n;
  let statementStart: string | null = null;
  let statementEnd: string | null = null;

  for (const row of document.rows) {
    const rawDate = pick(row.values, DATE_KEYS);
    const transactionDate = rawDate ? normaliseStatementDate(rawDate) : undefined;
    if (!transactionDate) {
      rows.push({
        line: row.line,
        verdict: 'unreadable',
        problem: rawDate
          ? `"${rawDate}" is not a date this understands. Use 2026-03-31 or 31/03/2026 — `
            + 'a two-digit year is refused rather than guessed at.'
          : 'No date on this row.',
      });
      unreadableCount += 1;
      continue;
    }

    const description = pick(row.values, DESCRIPTION_KEYS) ?? '';
    const rawAmount = pick(row.values, AMOUNT_KEYS);
    const rawDebit = pick(row.values, DEBIT_KEYS);
    const rawCredit = pick(row.values, CREDIT_KEYS);

    let amountMinor: Minor | undefined;
    if (rawAmount !== undefined) {
      amountMinor = parseStatementAmount(rawAmount, account.currency_code);
    } else if (rawCredit !== undefined || rawDebit !== undefined) {
      const credit = rawCredit ? parseStatementAmount(rawCredit, account.currency_code) : 0n;
      const debit = rawDebit ? parseStatementAmount(rawDebit, account.currency_code) : 0n;
      if (credit === undefined || debit === undefined) amountMinor = undefined;
      else {
        // A debit column holds a positive number for money going out.
        const outward = debit < 0n ? -debit : debit;
        const inward = credit < 0n ? -credit : credit;
        amountMinor = inward - outward;
      }
    }

    if (amountMinor === undefined) {
      rows.push({
        line: row.line,
        transactionDate,
        description,
        verdict: 'unreadable',
        problem: 'No amount this understands. Give an amount column, or a debit and a credit '
          + 'column.',
      });
      unreadableCount += 1;
      continue;
    }
    if (amountMinor === 0n) {
      // The table refuses a zero amount, and rightly: a zero movement is not a
      // movement. Reported rather than silently dropped.
      rows.push({
        line: row.line,
        transactionDate,
        description,
        verdict: 'unreadable',
        problem: 'The amount is zero. A zero movement is not imported.',
      });
      unreadableCount += 1;
      continue;
    }

    const externalId = pick(row.values, ID_KEYS) ?? null;

    let verdict: RowVerdict = 'new';
    let fingerprint: string | undefined;

    if (externalId) {
      const [existing] = await tx<{ id: string }[]>`
        select id from bank_transactions
         where bank_account_id = ${input.bankAccountId}::uuid
           and organisation_id = ${organisationId}::uuid
           and external_id = ${externalId}
      `;
      if (existing) verdict = 'already_imported';
    } else {
      const key = [transactionDate, description.trim().toLowerCase(), amountMinor.toString()]
        .join('\u0000');
      const alreadyInFile = seenInFile.get(key) ?? 0;

      // How many identical lines this account already carries.
      const [stored] = await tx<{ total: string }[]>`
        select count(*)::text as total
          from bank_transactions
         where bank_account_id = ${input.bankAccountId}::uuid
           and organisation_id = ${organisationId}::uuid
           and transaction_date = ${transactionDate}
           and amount_minor = ${amountMinor.toString()}
           and lower(btrim(description)) = ${description.trim().toLowerCase()}
      `;
      const storedCount = Number(stored?.total ?? '0');
      const occurrence = alreadyInFile + 1;
      seenInFile.set(key, occurrence);

      // The nth identical line in the file is the nth on the account. If the
      // account already has that many, this line is one of them.
      if (occurrence <= storedCount) verdict = 'already_imported';
      fingerprint = statementFingerprint(
        input.bankAccountId, { transactionDate, description, amountMinor }, occurrence,
      );
    }

    if (verdict === 'new') {
      newCount += 1;
      if (amountMinor > 0n) creditsMinor += amountMinor;
      else debitsMinor += -amountMinor;
    } else {
      duplicateCount += 1;
    }

    if (!statementStart || transactionDate < statementStart) statementStart = transactionDate;
    if (!statementEnd || transactionDate > statementEnd) statementEnd = transactionDate;

    rows.push({
      line: row.line, transactionDate, description, amountMinor, externalId, verdict, fingerprint,
    });
  }

  return {
    bankAccountId: input.bankAccountId,
    rows,
    newCount,
    duplicateCount,
    unreadableCount,
    creditsMinor,
    debitsMinor,
    statementStart,
    statementEnd,
    sourceSha256,
    sameFileAlreadyImported: Boolean(sameFile),
  };
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Imports the new lines, and nothing else.
 *
 * No receipt. No journal. No resident's balance moves by one cent. Every
 * imported line starts `unmatched`, and becomes a receipt only when somebody
 * decides who paid and confirms one.
 *
 * The preview is recomputed here rather than trusted from the browser: a
 * client that posts its own idea of which rows are new could import a
 * duplicate by saying so.
 */
export async function importStatement(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { bankAccountId: string; csv: string; filename: string },
): Promise<{
  importId: string;
  importedCount: number;
  duplicateCount: number;
  unreadableCount: number;
}> {
  await requirePermission(tx, organisationId, 'bank.import');
  const { filename } = parsed(
    z.object({ filename: z.string().trim().min(1).max(260) }),
    { filename: input.filename },
  );

  const preview = await previewStatementImport(tx, organisationId, {
    bankAccountId: input.bankAccountId, csv: input.csv,
  });

  if (preview.newCount === 0) {
    throw new DomainError(
      'conflict',
      preview.duplicateCount > 0
        ? 'Every line in that file is already imported. Nothing was changed.'
        : 'There is nothing importable in that file.',
    );
  }

  try {
    const [imported] = await tx<{ id: string }[]>`
      insert into bank_imports (
        organisation_id, bank_account_id, filename, source_sha256, row_count,
        imported_count, duplicate_count, status, statement_start, statement_end,
        created_by, committed_at
      ) values (
        ${organisationId}, ${input.bankAccountId}, ${filename},
        decode(${preview.sourceSha256}, 'hex'), ${preview.rows.length},
        ${preview.newCount}, ${preview.duplicateCount}, 'committed',
        ${preview.statementStart}, ${preview.statementEnd}, ${actorUserId}, now()
      )
      returning id
    `;
    if (!imported) throw new DomainError('internal', 'Bank import insert returned no row.');

    for (const row of preview.rows) {
      if (row.verdict !== 'new') continue;
      await tx`
        insert into bank_transactions (
          organisation_id, bank_account_id, import_id, transaction_date, description,
          amount_minor, currency_code, external_id, fingerprint, match_status
        ) values (
          ${organisationId}, ${input.bankAccountId}, ${imported.id},
          ${row.transactionDate!}, ${row.description ?? ''},
          ${row.amountMinor!.toString()},
          (select currency_code from bank_accounts where id = ${input.bankAccountId}::uuid),
          ${row.externalId ?? null},
          ${row.fingerprint ?? statementFingerprint(
            input.bankAccountId,
            {
              transactionDate: row.transactionDate!,
              description: row.description ?? '',
              amountMinor: row.amountMinor!,
            },
            1,
          )},
          'unmatched'
        )
      `;
    }

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'bank.statement_imported', resourceType: 'bank_import', resourceId: imported.id,
      after: {
        filename,
        bankAccountId: input.bankAccountId,
        importedCount: preview.newCount,
        duplicateCount: preview.duplicateCount,
        unreadableCount: preview.unreadableCount,
        statementStart: preview.statementStart,
        statementEnd: preview.statementEnd,
        // Said plainly in the audit trail: importing a statement moves nothing.
        ledgerEffect: 'none',
      },
    });

    return {
      importId: imported.id,
      importedCount: preview.newCount,
      duplicateCount: preview.duplicateCount,
      unreadableCount: preview.unreadableCount,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading what was imported                                                  */
/* -------------------------------------------------------------------------- */

export interface BankImportSummary {
  id: string;
  filename: string;
  bankName: string;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  statementStart: string | null;
  statementEnd: string | null;
  createdAt: string;
  createdByName: string | null;
  /** How many of this import's lines are still waiting to be identified. */
  unmatchedCount: number;
}

export async function listBankImports(
  tx: Sql, organisationId: string, limit = 24,
): Promise<BankImportSummary[]> {
  const rows = await tx<
    { id: string; filename: string; bank_name: string; row_count: number;
      imported_count: number; duplicate_count: number; statement_start: string | null;
      statement_end: string | null; created_at: string; created_by_name: string | null;
      unmatched_count: string }[]
  >`
    select i.id, i.filename, ba.bank_name, i.row_count, i.imported_count, i.duplicate_count,
           i.statement_start::text, i.statement_end::text, i.created_at::text,
           up.full_name as created_by_name,
           (select count(*) from bank_transactions bt
             where bt.import_id = i.id and bt.match_status in ('unmatched', 'suggested',
                                                               'needs_review'))::text
             as unmatched_count
      from bank_imports i
      join bank_accounts ba on ba.id = i.bank_account_id
      left join user_profiles up on up.auth_user_id = i.created_by
     where i.organisation_id = ${organisationId}::uuid and i.status = 'committed'
     order by i.created_at desc
     limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    bankName: r.bank_name,
    rowCount: r.row_count,
    importedCount: r.imported_count,
    duplicateCount: r.duplicate_count,
    statementStart: r.statement_start,
    statementEnd: r.statement_end,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    unmatchedCount: Number(r.unmatched_count),
  }));
}

export interface BankLine {
  id: string;
  transactionDate: string;
  description: string;
  amountMinor: bigint;
  currencyCode: string;
  matchStatus: 'unmatched' | 'suggested' | 'matched' | 'ignored' | 'needs_review';
  matchedReceiptId: string | null;
  matchedReceiptNumber: string | null;
  bankName: string;
  filename: string | null;
}

/**
 * Statement lines, money in first.
 *
 * A debit is money the organisation paid out and is not a receipt of anything;
 * it is kept and shown, because a statement read half-way is not reconciled,
 * but the unidentified credits are the work.
 */
export async function listBankLines(
  tx: Sql,
  organisationId: string,
  filter: { importId?: string; onlyUnmatched?: boolean } = {},
): Promise<BankLine[]> {
  const rows = await tx<
    { id: string; transaction_date: string; description: string; amount_minor: string;
      currency_code: string; match_status: string; matched_receipt_id: string | null;
      receipt_number: string | null; bank_name: string; filename: string | null }[]
  >`
    select bt.id, bt.transaction_date::text, bt.description, bt.amount_minor::text,
           bt.currency_code, bt.match_status, bt.matched_receipt_id,
           r.receipt_number, ba.bank_name, i.filename
      from bank_transactions bt
      join bank_accounts ba on ba.id = bt.bank_account_id
      left join bank_imports i on i.id = bt.import_id
      left join receipts r on r.id = bt.matched_receipt_id
     where bt.organisation_id = ${organisationId}::uuid
       ${filter.importId ? tx`and bt.import_id = ${filter.importId}::uuid` : tx``}
       ${filter.onlyUnmatched
         ? tx`and bt.match_status in ('unmatched', 'suggested', 'needs_review')`
         : tx``}
     order by bt.transaction_date desc, bt.amount_minor desc
     limit 500
  `;
  return rows.map((r) => ({
    id: r.id,
    transactionDate: r.transaction_date,
    description: r.description,
    amountMinor: BigInt(r.amount_minor),
    currencyCode: r.currency_code,
    matchStatus: r.match_status as BankLine['matchStatus'],
    matchedReceiptId: r.matched_receipt_id,
    matchedReceiptNumber: r.receipt_number,
    bankName: r.bank_name,
    filename: r.filename,
  }));
}

export async function getBankLine(
  tx: Sql, organisationId: string, bankTransactionId: string,
): Promise<BankLine | undefined> {
  const [row] = await tx<
    { id: string; transaction_date: string; description: string; amount_minor: string;
      currency_code: string; match_status: string; matched_receipt_id: string | null;
      receipt_number: string | null; bank_name: string; filename: string | null }[]
  >`
    select bt.id, bt.transaction_date::text, bt.description, bt.amount_minor::text,
           bt.currency_code, bt.match_status, bt.matched_receipt_id,
           r.receipt_number, ba.bank_name, i.filename
      from bank_transactions bt
      join bank_accounts ba on ba.id = bt.bank_account_id
      left join bank_imports i on i.id = bt.import_id
      left join receipts r on r.id = bt.matched_receipt_id
     where bt.id = ${bankTransactionId}::uuid
       and bt.organisation_id = ${organisationId}::uuid
  `;
  if (!row) return undefined;
  return {
    id: row.id,
    transactionDate: row.transaction_date,
    description: row.description,
    amountMinor: BigInt(row.amount_minor),
    currencyCode: row.currency_code,
    matchStatus: row.match_status as BankLine['matchStatus'],
    matchedReceiptId: row.matched_receipt_id,
    matchedReceiptNumber: row.receipt_number,
    bankName: row.bank_name,
    filename: row.filename,
  };
}

/**
 * Sets a statement line aside, with a reason.
 *
 * For a line that is not a resident's payment at all — a bank charge, a
 * transfer between the organisation's own accounts, an expense paid by card.
 * It is not deleted and it is not a receipt: it is marked as looked at, so the
 * unmatched list means "still to identify" rather than "everything ever".
 */
export async function ignoreBankLine(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { bankTransactionId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'bank.import');
  const reason = parsed(
    z.string().trim().min(5, 'Say why this line is not a receipt. The next reader needs it.')
      .max(500),
    input.reason,
  );

  const [line] = await tx<{ id: string; match_status: string }[]>`
    select id, match_status from bank_transactions
     where id = ${input.bankTransactionId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!line) throw notFound('Statement line');
  if (line.match_status === 'matched') {
    throw new DomainError(
      'conflict',
      'That line is already matched to a receipt. Reverse the receipt rather than setting the '
        + 'line aside, so the two never disagree.',
    );
  }

  await tx`
    update bank_transactions set match_status = 'ignored'
     where id = ${input.bankTransactionId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'bank.line_ignored', resourceType: 'bank_transaction',
    resourceId: input.bankTransactionId, reason,
    after: { ledgerEffect: 'none' },
  });
}

/** Puts an ignored line back on the worklist. */
export async function reopenBankLine(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { bankTransactionId: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'bank.import');

  const [line] = await tx<{ id: string; match_status: string }[]>`
    select id, match_status from bank_transactions
     where id = ${input.bankTransactionId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!line) throw notFound('Statement line');
  if (line.match_status !== 'ignored') {
    throw new DomainError('conflict', `That line is "${line.match_status}", not set aside.`);
  }

  await tx`
    update bank_transactions set match_status = 'unmatched'
     where id = ${input.bankTransactionId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'bank.line_reopened', resourceType: 'bank_transaction',
    resourceId: input.bankTransactionId,
    after: { ledgerEffect: 'none' },
  });
}

/* -------------------------------------------------------------------------- */
/* Suggesting a payer                                                         */
/* -------------------------------------------------------------------------- */

export interface PayerCandidate {
  leaseId: string;
  reference: string;
  label: string;
  outstandingMinor: bigint;
  /** Why this lease is being offered, in words, never as a score. */
  because: string;
}

/**
 * Leases a statement line might belong to.
 *
 * A suggestion, never a decision. It matches on the payment reference an
 * operator can see in the description, and on the amount owed — and it says
 * which of the two it was, because "we think it is this one" is useless to
 * somebody who has to be able to defend the allocation later.
 *
 * Nothing here writes. Confirming a receipt is a separate, deliberate act.
 */
export async function suggestPayers(
  tx: Sql,
  organisationId: string,
  input: { bankTransactionId: string },
): Promise<PayerCandidate[]> {
  // A suggestion is only useful to somebody who could act on it, and reading
  // every lease's arrears to produce one is not a general-purpose read.
  await requirePermission(tx, organisationId, 'payment.record');
  const line = await getBankLine(tx, organisationId, input.bankTransactionId);
  if (!line) throw notFound('Statement line');
  if (line.amountMinor <= 0n) return [];

  const rows = await tx<
    { id: string; reference: string; label: string; outstanding_minor: string;
      resident_surname: string | null; unit_code: string }[]
  >`
    select l.id, l.reference,
           p.name || ' / ' || u.code || ' — ' ||
             coalesce(nullif(trim(coalesce(rp.first_name, '') || ' ' ||
                                  coalesce(rp.last_name, '')), ''),
                      'no resident on file') as label,
           coalesce((
             select sum(b.outstanding_minor) from charge_line_balances b
              where b.lease_id = l.id and b.outstanding_minor > 0
           ), 0)::text as outstanding_minor,
           rp.last_name as resident_surname,
           u.code as unit_code
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp
        on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where l.organisation_id = ${organisationId}::uuid
       and l.status in ('active', 'notice_given', 'expired')
     limit 500
  `;

  const haystack = line.description.toUpperCase();
  const candidates: PayerCandidate[] = [];

  for (const row of rows) {
    const outstanding = BigInt(row.outstanding_minor);
    const reasons: string[] = [];

    if (row.resident_surname && row.resident_surname.length >= 3
        && haystack.includes(row.resident_surname.toUpperCase())) {
      reasons.push(`the description contains "${row.resident_surname}"`);
    }
    if (row.unit_code.length >= 3 && haystack.includes(row.unit_code.toUpperCase())) {
      reasons.push(`the description contains the unit code "${row.unit_code}"`);
    }
    if (haystack.includes(row.reference.toUpperCase())) {
      reasons.push(`the description contains the lease reference ${row.reference}`);
    }
    if (outstanding > 0n && outstanding === line.amountMinor) {
      reasons.push('the amount is exactly what this lease owes');
    }

    if (reasons.length === 0) continue;
    candidates.push({
      leaseId: row.id,
      reference: row.reference,
      label: row.label,
      outstandingMinor: outstanding,
      because: reasons.join(', and '),
    });
  }

  // The strongest evidence first, but the operator still chooses. A single
  // candidate is not auto-applied anywhere.
  return candidates.sort((a, b) => b.because.length - a.because.length).slice(0, 10);
}
