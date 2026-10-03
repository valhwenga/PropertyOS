import type { Sql } from '@propertyos/db';
import { DomainError, invalid, fromDatabaseError } from './errors';
import type { Minor } from './money';
import { sumMinor } from './money';

export type SystemAccountRole =
  | 'resident_receivable' | 'unapplied_receipts' | 'rental_income'
  | 'utility_recovery_income' | 'other_income' | 'bank_control'
  | 'deposit_bank_control' | 'deposit_liability' | 'deposit_interest_expense'
  | 'suspense' | 'property_expense' | 'write_off_expense' | 'opening_equity';

export type JournalSource =
  | 'opening_balance' | 'rent_charge' | 'utility_charge' | 'adjustment' | 'receipt'
  | 'allocation' | 'deposit' | 'deposit_refund' | 'expense' | 'reversal' | 'write_off';

export interface JournalLineInput {
  /** Either an explicit account id, or a system role resolved within the book. */
  accountId?: string;
  accountRole?: SystemAccountRole;
  debitMinor?: Minor;
  creditMinor?: Minor;
  leaseId?: string | null;
  propertyId?: string | null;
  unitId?: string | null;
  memo?: string | null;
}

export interface PostJournalInput {
  organisationId: string;
  bookId: string;
  currencyCode: string;
  postingDate: string;
  source: JournalSource;
  description: string;
  sourceTable?: string;
  sourceId?: string;
  postedBy: string | null;
  correlationId?: string | null;
  reversesJournalId?: string;
  reversalReason?: string;
  lines: JournalLineInput[];
}

/** Resolves the system accounts for a book in a single round trip. */
export async function resolveSystemAccounts(
  tx: Sql,
  bookId: string,
): Promise<Map<SystemAccountRole, string>> {
  const rows = await tx<{ id: string; system_role: SystemAccountRole }[]>`
    select id, system_role from accounts
    where book_id = ${bookId}::uuid and system_role is not null and is_active
  `;
  return new Map(rows.map((r) => [r.system_role, r.id]));
}

/**
 * Posts one balanced journal.
 *
 * The balance is NOT asserted from a client-supplied total. It is checked here
 * for a readable error, and then enforced again by a deferred constraint trigger
 * in the database before the transaction may commit — so an unbalanced journal
 * cannot exist even if this function were bypassed.
 */
export async function postJournal(tx: Sql, input: PostJournalInput): Promise<string> {
  if (input.lines.length < 2) {
    throw invalid('A journal requires at least two lines.');
  }

  const accounts = await resolveSystemAccounts(tx, input.bookId);
  const resolved = input.lines.map((line, index) => {
    const accountId = line.accountId ?? (line.accountRole ? accounts.get(line.accountRole) : undefined);
    if (!accountId) {
      throw invalid(
        `Journal line ${index + 1} does not resolve to an account` +
          (line.accountRole ? ` (no account carries the "${line.accountRole}" role in this book).` : '.'),
      );
    }
    const debit = line.debitMinor ?? 0n;
    const credit = line.creditMinor ?? 0n;
    if (debit < 0n || credit < 0n) throw invalid('Journal amounts must be non-negative.');
    if ((debit > 0n) === (credit > 0n)) {
      throw invalid(`Journal line ${index + 1} must carry exactly one of debit or credit.`);
    }
    return { ...line, accountId, debit, credit };
  });

  const net = sumMinor(resolved.map((l) => l.debit - l.credit));
  if (net !== 0n) {
    throw new DomainError(
      'internal',
      `Refusing to post an unbalanced journal: debits minus credits = ${net} minor units.`,
    );
  }

  try {
    const [journal] = await tx<{ id: string }[]>`
      insert into journals (
        organisation_id, book_id, currency_code, posting_date, source,
        source_table, source_id, description, posted_by, correlation_id,
        reverses_journal_id, reversal_reason
      ) values (
        ${input.organisationId}, ${input.bookId}, ${input.currencyCode},
        ${input.postingDate}, ${input.source}, ${input.sourceTable ?? null},
        ${input.sourceId ?? null}, ${input.description}, ${input.postedBy},
        ${input.correlationId ?? null}, ${input.reversesJournalId ?? null},
        ${input.reversalReason ?? null}
      )
      returning id
    `;
    if (!journal) throw new DomainError('internal', 'Journal insert returned no row.');

    await tx`
      insert into journal_lines ${tx(
        resolved.map((line, index) => ({
          organisation_id: input.organisationId,
          journal_id: journal.id,
          account_id: line.accountId,
          debit_minor: line.debit.toString(),
          credit_minor: line.credit.toString(),
          currency_code: input.currencyCode,
          lease_id: line.leaseId ?? null,
          property_id: line.propertyId ?? null,
          unit_id: line.unitId ?? null,
          memo: line.memo ?? null,
          line_number: index + 1,
        })),
      )}
    `;
    return journal.id;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

/**
 * Creates the mirror-image journal that reverses an existing one.
 * The original is left untouched: financial history is corrected by linked
 * reversal, never by edit or delete.
 */
export async function reverseJournal(
  tx: Sql,
  params: {
    organisationId: string;
    journalId: string;
    reason: string;
    postingDate: string;
    postedBy: string | null;
    correlationId?: string | null;
  },
): Promise<string> {
  if (params.reason.trim().length < 5) {
    throw invalid('A reversal requires a reason of at least 5 characters.');
  }
  const [original] = await tx<
    { id: string; book_id: string; currency_code: string; description: string }[]
  >`
    select id, book_id, currency_code, description from journals
    where id = ${params.journalId}::uuid and organisation_id = ${params.organisationId}::uuid
  `;
  if (!original) throw new DomainError('not_found', 'Journal not found.');

  const lines = await tx<
    {
      account_id: string; debit_minor: string; credit_minor: string;
      lease_id: string | null; property_id: string | null; unit_id: string | null;
    }[]
  >`
    select account_id, debit_minor, credit_minor, lease_id, property_id, unit_id
    from journal_lines where journal_id = ${params.journalId}::uuid order by line_number
  `;

  return postJournal(tx, {
    organisationId: params.organisationId,
    bookId: original.book_id,
    currencyCode: original.currency_code,
    postingDate: params.postingDate,
    source: 'reversal',
    description: `Reversal of: ${original.description}`,
    sourceTable: 'journals',
    sourceId: params.journalId,
    postedBy: params.postedBy,
    correlationId: params.correlationId ?? null,
    reversesJournalId: params.journalId,
    reversalReason: params.reason,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      // Sides swapped.
      debitMinor: BigInt(l.credit_minor),
      creditMinor: BigInt(l.debit_minor),
      leaseId: l.lease_id,
      propertyId: l.property_id,
      unitId: l.unit_id,
    })),
  });
}

/** Proves a book balances. Used by tests and by the finance health check. */
export async function assertBookBalances(tx: Sql, bookId: string): Promise<void> {
  const rows = await tx<{ currency_code: string; net: string }[]>`
    select j.currency_code, sum(jl.signed_minor)::text as net
    from journal_lines jl
    join journals j on j.id = jl.journal_id
    where j.book_id = ${bookId}::uuid
    group by j.currency_code
  `;
  for (const row of rows) {
    if (BigInt(row.net) !== 0n) {
      throw new DomainError(
        'internal',
        `Book ${bookId} does not balance in ${row.currency_code}: net ${row.net} minor units.`,
      );
    }
  }
}
