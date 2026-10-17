/**
 * Reading a ledger without changing it.
 *
 * Two presentation rules, and the whole risk in both is that a statement stops
 * reconciling. A summary that disagrees with its own rows, or a grouped
 * payment whose running balance no longer describes the rows above it, is a
 * worse screen than the one it replaced — a resident would be right to doubt
 * every figure on it.
 */
import { describe, it, expect } from 'vitest';
import type { Statement, StatementLine } from '@propertyos/domain';
import {
  groupStatementEntries, splitDescription, summariseStatement,
} from '../../apps/web/src/lib/statement-view';

const line = (over: Partial<StatementLine>): StatementLine => ({
  entryDate: '2026-01-01', dueDate: '2026-01-01', kind: 'charge', type: 'rent',
  reference: 'INV-000001', description: 'Monthly rent',
  debitMinor: 0n, creditMinor: 0n, runningBalanceMinor: 0n, ...over,
});

/** The acceptance fixture: R1,000 arrears, R8,000 rent, R350 water, R7,500 paid. */
const FIXTURE: StatementLine[] = [
  line({ reference: 'OPB-000001', description: 'Opening arrears brought forward (DEMO, operator signed 31/12/2025)', entryDate: '2025-12-31', debitMinor: 100_000n, runningBalanceMinor: 100_000n }),
  line({ reference: 'INV-000001', description: 'Monthly rent', debitMinor: 800_000n, runningBalanceMinor: 900_000n }),
  line({ reference: 'INV-000002', description: 'Water — January reading', entryDate: '2026-01-05', debitMinor: 35_000n, runningBalanceMinor: 935_000n }),
  line({ reference: 'RCT-000001', kind: 'allocation', description: 'Receipt allocated to Opening arrears', entryDate: '2026-01-07', creditMinor: 100_000n, runningBalanceMinor: 835_000n }),
  line({ reference: 'RCT-000001', kind: 'allocation', description: 'Receipt allocated to Monthly rent', entryDate: '2026-01-07', creditMinor: 650_000n, runningBalanceMinor: 185_000n }),
];

const statement = (lines: StatementLine[], opening = 0n, closing?: bigint): Statement => ({
  leaseId: 'lease', leaseReference: 'LSE-000001', organisationId: 'org', currencyCode: 'ZAR',
  cutOff: '2026-10-17', openingBalanceMinor: opening,
  openingBalanceSource: opening === 0n ? 'no_prior_activity' : 'prior_activity',
  lines,
  closingReceivableMinor: closing ?? (lines[lines.length - 1]?.runningBalanceMinor ?? opening),
  unappliedCreditMinor: 0n, depositHeldMinor: 0n, pendingEvidence: [],
  generatedAt: '2026-10-17T08:00:00.000Z',
});

describe('summariseStatement', () => {
  it('reconciles opening plus charges less payments to the closing balance', () => {
    const summary = summariseStatement(statement(FIXTURE));
    expect(summary.openingMinor).toBe(0n);
    expect(summary.chargesMinor).toBe(935_000n);
    expect(summary.paymentsMinor).toBe(750_000n);
    expect(summary.closingMinor).toBe(185_000n);
    expect(summary.balanced).toBe(true);
  });

  it('carries an opening balance from before the window', () => {
    const summary = summariseStatement(statement(
      [line({ debitMinor: 800_000n, runningBalanceMinor: 900_000n })], 100_000n,
    ));
    expect(summary.openingMinor).toBe(100_000n);
    expect(summary.balanced).toBe(true);
  });

  it('reports a set that does not reconcile instead of hiding it', () => {
    // The page shows a warning on this rather than printing a summary that
    // contradicts its own rows.
    const broken = statement(FIXTURE, 0n, 999_999n);
    expect(summariseStatement(broken).balanced).toBe(false);
  });
});

describe('groupStatementEntries', () => {
  it('shows one receipt once, with its allocations underneath', () => {
    const entries = groupStatementEntries(FIXTURE);
    expect(entries).toHaveLength(4);

    const payment = entries[3]!;
    expect(payment.kind).toBe('payment');
    expect(payment.creditMinor).toBe(750_000n);
    expect(payment.parts.map((p) => p.creditMinor)).toEqual([100_000n, 650_000n]);
    // The balance after the LAST line of the group, which is what the column
    // means: the balance after everything above it.
    expect(payment.runningBalanceMinor).toBe(185_000n);
  });

  it('does not double count: the grouped total is the sum of its parts', () => {
    const entries = groupStatementEntries(FIXTURE);
    const credited = entries.reduce((sum, e) => sum + e.creditMinor, 0n);
    const fromLines = FIXTURE.reduce((sum, l) => sum + l.creditMinor, 0n);
    expect(credited).toBe(fromLines);
  });

  it('leaves a reversal as its own row', () => {
    // A reversal is a DEBIT against the same receipt reference. Sweeping it
    // into the payment would show a smaller payment that never happened and
    // lose the fact that money was taken back.
    const withReversal: StatementLine[] = [
      ...FIXTURE,
      line({
        reference: 'RCT-000001', kind: 'allocation', entryDate: '2026-02-01',
        description: 'Allocation reversed', debitMinor: 650_000n, runningBalanceMinor: 835_000n,
      }),
    ];
    const entries = groupStatementEntries(withReversal);
    const last = entries[entries.length - 1]!;
    expect(last.debitMinor).toBe(650_000n);
    expect(last.parts).toHaveLength(0);
    expect(entries.filter((e) => e.kind === 'payment')).toHaveLength(1);
  });

  it('does not group across dates, even for the same receipt', () => {
    const splitDates: StatementLine[] = [
      line({ reference: 'RCT-9', kind: 'allocation', entryDate: '2026-01-07', creditMinor: 100n, runningBalanceMinor: 900n }),
      line({ reference: 'RCT-9', kind: 'allocation', entryDate: '2026-02-07', creditMinor: 200n, runningBalanceMinor: 700n }),
    ];
    expect(groupStatementEntries(splitDates)).toHaveLength(2);
  });

  it('keeps a single allocation as itself rather than calling it "Payment received"', () => {
    const one = [FIXTURE[3]!];
    const entries = groupStatementEntries(one);
    expect(entries[0]!.description).toContain('Receipt allocated');
    expect(entries[0]!.parts).toHaveLength(0);
  });

  it('runs the balance down the page in order', () => {
    const entries = groupStatementEntries(FIXTURE);
    expect(entries.map((e) => e.runningBalanceMinor))
      .toEqual([100_000n, 900_000n, 935_000n, 185_000n]);
  });
});

describe('splitDescription', () => {
  it('moves operator detail out of the line and keeps it', () => {
    const { lead, note } = splitDescription(
      'Opening arrears brought forward (DEMO, operator signed 31/12/2025)',
    );
    expect(lead).toBe('Opening arrears brought forward');
    expect(note).toBe('DEMO, operator signed 31/12/2025');
  });

  it('leaves an ordinary description alone', () => {
    expect(splitDescription('Monthly rent')).toEqual({ lead: 'Monthly rent', note: null });
  });

  it('does not split a description whose brackets are in the middle', () => {
    const { lead, note } = splitDescription('Water (January) reading reviewed');
    expect(lead).toBe('Water (January) reading reviewed');
    expect(note).toBeNull();
  });
});
