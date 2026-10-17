import type { Statement, StatementLine } from '@propertyos/domain';

/**
 * Turning a ledger into something a resident can read, without changing it.
 *
 * Two jobs, both presentation. The summary adds up the lines the page is about
 * to show, so the four figures and the table cannot disagree. And a receipt
 * that paid three charges is one payment to the person who made it: the three
 * allocation lines become one row with the detail underneath.
 *
 * No arithmetic here decides anything. The closing balance is the one the
 * domain computed, and the grouped row carries the running balance of the last
 * line it contains, so the column still reads correctly down the page.
 *
 * Deliberately free of React and of the database, so the rules can be tested
 * against real statements on their own.
 */

export interface StatementSummary {
  openingMinor: bigint;
  chargesMinor: bigint;
  paymentsMinor: bigint;
  closingMinor: bigint;
  /** True when the four figures reconcile, which they must. */
  balanced: boolean;
}

export function summariseStatement(statement: Statement): StatementSummary {
  let charges = 0n;
  let payments = 0n;
  for (const line of statement.lines) {
    charges += line.debitMinor;
    payments += line.creditMinor;
  }
  const closing = statement.closingReceivableMinor;
  return {
    openingMinor: statement.openingBalanceMinor,
    chargesMinor: charges,
    paymentsMinor: payments,
    closingMinor: closing,
    // Opening + charges − payments must be the closing balance the domain
    // reported. If it ever is not, the page says so rather than printing a
    // summary that quietly disagrees with its own rows.
    balanced: statement.openingBalanceMinor + charges - payments === closing,
  };
}

/**
 * Splits a ledger description into what a resident needs and what they do not.
 *
 * Descriptions carry operator detail that is meaningful in the books and noise
 * on a phone: "Opening arrears brought forward (DEMO, operator signed
 * 31/12/2025)" is two sentences, one of them about a data migration. The lead
 * text is shown; the parenthetical moves into the expandable detail.
 *
 * Presentation only. The stored description is never altered, and the note is
 * shown rather than discarded — a resident can still read exactly what the
 * ledger says.
 */
export function splitDescription(description: string): { lead: string; note: string | null } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(description.trim());
  if (!match || !match[1]) return { lead: description.trim(), note: null };
  return { lead: match[1].trim(), note: match[2]!.trim() || null };
}

export interface StatementEntry {
  key: string;
  entryDate: string;
  description: string;
  reference: string;
  debitMinor: bigint;
  creditMinor: bigint;
  runningBalanceMinor: bigint;
  /** 'charge', 'payment' (a grouped receipt), or 'single' for one line. */
  kind: 'charge' | 'payment' | 'single';
  /** Operator detail lifted out of the description, shown in the detail. */
  note: string | null;
  /** The allocations behind a grouped payment, for the expandable detail. */
  parts: StatementLine[];
}

/**
 * Groups the allocations of one receipt into a single payment entry.
 *
 * Only when grouping cannot mislead:
 *   - the lines are adjacent in the ordered statement, so nothing is reordered;
 *   - they share a reference and a date, so the entry has one of each;
 *   - every one of them is a credit, so a reversal — which is a debit against
 *     the same reference — stays a row of its own, visible, where it belongs.
 *
 * The running balance shown is the one after the last line in the group, which
 * is what the column means: the balance after everything above it.
 */
export function groupStatementEntries(lines: readonly StatementLine[]): StatementEntry[] {
  const entries: StatementEntry[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const groupable = line.kind === 'allocation' && line.creditMinor > 0n && line.debitMinor === 0n;

    if (!groupable) {
      const { lead, note } = splitDescription(line.description);
      entries.push({
        key: `${line.reference}-${index}`,
        entryDate: line.entryDate,
        description: lead,
        note,
        reference: line.reference,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        runningBalanceMinor: line.runningBalanceMinor,
        kind: line.kind === 'charge' ? 'charge' : 'single',
        parts: [],
      });
      index += 1;
      continue;
    }

    const parts: StatementLine[] = [];
    while (index < lines.length) {
      const next = lines[index]!;
      const sameReceipt = next.kind === 'allocation'
        && next.reference === line.reference
        && next.entryDate === line.entryDate
        && next.creditMinor > 0n
        && next.debitMinor === 0n;
      if (!sameReceipt) break;
      parts.push(next);
      index += 1;
    }

    const last = parts[parts.length - 1]!;
    const total = parts.reduce((sum, p) => sum + p.creditMinor, 0n);
    const single = parts.length === 1 ? splitDescription(parts[0]!.description) : null;
    entries.push({
      key: `${line.reference}-${line.entryDate}`,
      entryDate: line.entryDate,
      description: single ? single.lead : 'Payment received',
      note: single ? single.note : null,
      reference: line.reference,
      debitMinor: 0n,
      creditMinor: total,
      runningBalanceMinor: last.runningBalanceMinor,
      kind: parts.length === 1 ? 'single' : 'payment',
      parts: parts.length === 1 ? [] : parts,
    });
  }

  return entries;
}
