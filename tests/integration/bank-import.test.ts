/**
 * Importing a bank statement.
 *
 * The tables have existed since the schema was written, with two unique
 * indexes to stop an overlapping statement being imported twice, and nothing
 * could write a row to either. So the one thing a landlord does every month —
 * sit down with the statement and work out who paid — had no support at all.
 *
 * The rule that governs everything here: a line on a bank statement is NOT a
 * receipt. It is evidence money arrived. Importing writes no receipt, posts no
 * journal and moves no resident's balance, and the first test says so in those
 * terms. The second thing being tested is the one that is genuinely hard: two
 * identical payments on one day must both survive, and the same line in two
 * overlapping statements must not be imported twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  activateLease, addBankAccount, confirmReceipt, createResident, createStandaloneHouse,
  draftLease, getBankLine, ignoreBankLine, importStatement, listBankImports, listBankLines,
  normaliseStatementDate, parseMajorToMinor, parseStatementAmount, postCharge,
  previewStatementImport, reopenBankLine, suggestPayers,
} from '@propertyos/domain';
import {
  as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

describe('Bank statement import', () => {
  let org: OrganisationFixture;
  let bankAccountId: string;
  let leaseId: string;

  /** Everything the lease still owes, across every posted charge. */
  async function outstanding(): Promise<bigint> {
    const [row] = await ownerSql()<{ total: string }[]>`
      select coalesce(sum(outstanding_minor), 0)::text as total
        from charge_line_balances where lease_id = ${leaseId}
    `;
    return BigInt(row!.total);
  }

  async function receiptCount(): Promise<number> {
    const [row] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from receipts
       where organisation_id = ${org.organisationId}
    `;
    return Number(row!.total);
  }

  beforeAll(async () => {
    org = await createOrganisation('Statement Co');

    const account = await as(org.adminUserId, (tx) =>
      addBankAccount(tx, org.organisationId, org.adminUserId, {
        label: 'Operating', bankName: 'Demo Bank', accountHolder: 'Statement Co',
        accountNumber: '62001234567', branchCode: '250655',
        reason: 'Opened for the integration suite.',
      }),
    );
    bankAccountId = account.bankAccountId;

    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Statement House', code: 'STM', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31',
        rentMinor: R('8000'),
        parties: [{ residentId: resident.residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Contract filed offline.',
      }),
    );
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice',
        issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{
          category: 'rent', description: 'January rent',
          amountMinor: R('8000'), dueDate: '2026-01-01',
        }],
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------------- reading a file */

  it('reads the dates and amounts a bank actually writes', () => {
    expect(normaliseStatementDate('2026-01-07')).toBe('2026-01-07');
    expect(normaliseStatementDate('07/01/2026')).toBe('2026-01-07');
    expect(normaliseStatementDate('7.1.2026')).toBe('2026-01-07');
    // A two-digit year is refused rather than guessed: a line in the wrong
    // century lands in the wrong period and nobody notices until the month
    // will not reconcile.
    expect(normaliseStatementDate('07/01/26')).toBeUndefined();
    expect(normaliseStatementDate('31/13/2026')).toBeUndefined();

    expect(parseStatementAmount('7 500.00', 'ZAR')).toBe(R('7500'));
    expect(parseStatementAmount('7,500.00', 'ZAR')).toBe(R('7500'));
    expect(parseStatementAmount('-350.00', 'ZAR')).toBe(-R('350'));
    expect(parseStatementAmount('350.00-', 'ZAR')).toBe(-R('350'));
    expect(parseStatementAmount('(350.00)', 'ZAR')).toBe(-R('350'));
    expect(parseStatementAmount('R 1 850.00', 'ZAR')).toBe(R('1850'));
    expect(parseStatementAmount('not a number', 'ZAR')).toBeUndefined();
  });

  /* --------------------------------------- importing moves nothing at all */

  it('imports statement lines without creating a receipt or moving a balance', async () => {
    const owedBefore = await outstanding();
    const receiptsBefore = await receiptCount();
    expect(owedBefore).toBe(R('8000'));

    const csv = [
      'Date,Description,Amount',
      '07/01/2026,EFT MOKOENA PROTEA14,7500.00',
      '05/01/2026,BANK CHARGES,-57.50',
      '09/01/2026,EFT UNKNOWN PAYER,1850.00',
    ].join('\n');

    const result = await as(org.adminUserId, (tx) =>
      importStatement(tx, org.organisationId, org.adminUserId, {
        bankAccountId, csv, filename: 'january.csv',
      }),
    );
    expect(result.importedCount).toBe(3);
    expect(result.duplicateCount).toBe(0);

    // The whole point. Money appearing on a statement is evidence, not a
    // receipt: nothing is owed less and no receipt exists.
    expect(await outstanding()).toBe(owedBefore);
    expect(await receiptCount()).toBe(receiptsBefore);

    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, {}),
    );
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.matchStatus === 'unmatched')).toBe(true);
    // A debit is kept, not discarded: a statement read half-way is not
    // reconciled.
    expect(lines.find((l) => l.description === 'BANK CHARGES')!.amountMinor).toBe(-R('57.50'));
  });

  it('records the statement period and who imported it', async () => {
    const [imported] = await as(org.adminUserId, (tx) =>
      listBankImports(tx, org.organisationId),
    );
    expect(imported!.filename).toBe('january.csv');
    expect(imported!.statementStart).toBe('2026-01-05');
    expect(imported!.statementEnd).toBe('2026-01-09');
    expect(imported!.importedCount).toBe(3);
    expect(imported!.unmatchedCount).toBe(3);
  });

  /* ----------------------------------------- the hard part: overlapping */

  it('refuses the identical file twice', async () => {
    const csv = [
      'Date,Description,Amount',
      '07/01/2026,EFT MOKOENA PROTEA14,7500.00',
      '05/01/2026,BANK CHARGES,-57.50',
      '09/01/2026,EFT UNKNOWN PAYER,1850.00',
    ].join('\n');

    const preview = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv }),
    );
    expect(preview.newCount).toBe(0);
    expect(preview.duplicateCount).toBe(3);
    expect(preview.sameFileAlreadyImported).toBe(true);

    await expect(
      as(org.adminUserId, (tx) =>
        importStatement(tx, org.organisationId, org.adminUserId, {
          bankAccountId, csv, filename: 'january-again.csv',
        }),
      ),
    ).rejects.toThrow(/already imported/);
  });

  it('imports only the new lines from an overlapping statement', async () => {
    // A February statement that starts a few days early, as a real export
    // does when the operator picks a rough date range.
    const csv = [
      'Date,Description,Amount',
      '07/01/2026,EFT MOKOENA PROTEA14,7500.00',
      '09/01/2026,EFT UNKNOWN PAYER,1850.00',
      '03/02/2026,EFT MOKOENA PROTEA14,8000.00',
    ].join('\n');

    const preview = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv }),
    );
    expect(preview.newCount).toBe(1);
    expect(preview.duplicateCount).toBe(2);
    expect(preview.creditsMinor).toBe(R('8000'));

    const result = await as(org.adminUserId, (tx) =>
      importStatement(tx, org.organisationId, org.adminUserId, {
        bankAccountId, csv, filename: 'february.csv',
      }),
    );
    expect(result.importedCount).toBe(1);
    expect(result.duplicateCount).toBe(2);

    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, {}),
    );
    expect(lines).toHaveLength(4);
  });

  it('keeps two genuinely separate identical payments on one day', async () => {
    // Two R500 payments from the same payer on the same day are two payments.
    // Collapsing them loses R500 of somebody's money.
    const csv = [
      'Date,Description,Amount',
      '10/02/2026,EFT CASH DEPOSIT,500.00',
      '10/02/2026,EFT CASH DEPOSIT,500.00',
    ].join('\n');

    const first = await as(org.adminUserId, (tx) =>
      importStatement(tx, org.organisationId, org.adminUserId, {
        bankAccountId, csv, filename: 'two-identical.csv',
      }),
    );
    expect(first.importedCount).toBe(2);

    const [row] = await ownerSql()<{ total: string }[]>`
      select count(*)::text as total from bank_transactions
       where bank_account_id = ${bankAccountId}
         and transaction_date = '2026-02-10' and amount_minor = 50000
    `;
    expect(row!.total).toBe('2');

    // And re-importing a statement that contains the same pair adds neither.
    const preview = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv }),
    );
    expect(preview.newCount).toBe(0);
    expect(preview.duplicateCount).toBe(2);

    // A THIRD identical payment on that day is a new line, not a duplicate.
    const withThird = `${csv}\n10/02/2026,EFT CASH DEPOSIT,500.00`;
    const third = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv: withThird }),
    );
    expect(third.newCount).toBe(1);
    expect(third.duplicateCount).toBe(2);
  });

  it('uses the bank\'s own identifier when the file has one', async () => {
    const csv = [
      'Date,Description,Amount,Transaction ID',
      '12/02/2026,EFT DLAMINI,2200.00,TXN-00099',
    ].join('\n');

    await as(org.adminUserId, (tx) =>
      importStatement(tx, org.organisationId, org.adminUserId, {
        bankAccountId, csv, filename: 'with-ids.csv',
      }),
    );

    // Same identifier, different wording and a different day — still the same
    // transaction, because the bank says so.
    const restated = [
      'Date,Description,Amount,Transaction ID',
      '13/02/2026,EFT N DLAMINI RENT,2200.00,TXN-00099',
    ].join('\n');
    const preview = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv: restated }),
    );
    expect(preview.newCount).toBe(0);
    expect(preview.duplicateCount).toBe(1);
  });

  /* ------------------------------------------------- unreadable rows */

  it('reports a bad row against the operator\'s own line number', async () => {
    const csv = [
      'Date,Description,Amount',
      '15/02/2026,GOOD ROW,100.00',
      '15/02/26,TWO DIGIT YEAR,100.00',
      '16/02/2026,NO AMOUNT,',
      '17/02/2026,ZERO,0.00',
    ].join('\n');

    const preview = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv }),
    );
    expect(preview.newCount).toBe(1);
    expect(preview.unreadableCount).toBe(3);

    // Line 3 of the file, not row 2 of some internal array.
    const bad = preview.rows.find((r) => r.line === 3)!;
    expect(bad.verdict).toBe('unreadable');
    expect(bad.problem).toContain('two-digit year');
    expect(preview.rows.find((r) => r.line === 5)!.problem).toContain('zero');
  });

  it('refuses a file with no date column, naming the headers it found', async () => {
    await expect(
      as(org.adminUserId, (tx) =>
        previewStatementImport(tx, org.organisationId, {
          bankAccountId, csv: 'When,What,How much\n2026-01-01,RENT,100.00',
        }),
      ),
    ).rejects.toThrow(/When, What, How much/);
  });

  it('reads separate debit and credit columns', async () => {
    const csv = [
      'Date,Details,Debit,Credit',
      '20/02/2026,EFT IN,,3300.00',
      '21/02/2026,EFT OUT,420.00,',
    ].join('\n');

    const preview = await as(org.adminUserId, (tx) =>
      previewStatementImport(tx, org.organisationId, { bankAccountId, csv }),
    );
    expect(preview.newCount).toBe(2);
    expect(preview.creditsMinor).toBe(R('3300'));
    // A debit column holds a positive number for money going out.
    expect(preview.debitsMinor).toBe(R('420'));
    expect(preview.rows.find((r) => r.line === 3)!.amountMinor).toBe(-R('420'));
  });

  /* --------------------------------------------- identifying the payer */

  it('suggests a payer and says why, without deciding', async () => {
    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, { onlyUnmatched: true }),
    );
    const mokoena = lines.find((l) => l.description === 'EFT MOKOENA PROTEA14'
      && l.amountMinor === R('7500'))!;

    const candidates = await as(org.adminUserId, (tx) =>
      suggestPayers(tx, org.organisationId, { bankTransactionId: mokoena.id }),
    );
    expect(candidates).toHaveLength(1);
    // The reason is in words an operator could repeat to a resident, not a
    // score they would have to take on trust.
    expect(candidates[0]!.because).toContain('Mokoena');
    expect(candidates[0]!.leaseId).toBe(leaseId);

    // Suggesting changed nothing: still unmatched, still no receipt.
    const after = await as(org.adminUserId, (tx) =>
      getBankLine(tx, org.organisationId, mokoena.id),
    );
    expect(after!.matchStatus).toBe('unmatched');
  });

  it('offers nothing for a debit', async () => {
    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, {}),
    );
    const charges = lines.find((l) => l.description === 'BANK CHARGES')!;
    const candidates = await as(org.adminUserId, (tx) =>
      suggestPayers(tx, org.organisationId, { bankTransactionId: charges.id }),
    );
    expect(candidates).toHaveLength(0);
  });

  it('links the line to the receipt only when somebody confirms one', async () => {
    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, { onlyUnmatched: true }),
    );
    const mokoena = lines.find((l) => l.description === 'EFT MOKOENA PROTEA14'
      && l.amountMinor === R('7500'))!;

    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('7500'), receivedOn: '2026-01-07', method: 'eft',
        payerReference: 'MOKOENA PROTEA14', bankTransactionId: mokoena.id,
      }),
    );
    expect(receipt.inSuspense).toBe(false);

    const matched = await as(org.adminUserId, (tx) =>
      getBankLine(tx, org.organisationId, mokoena.id),
    );
    expect(matched!.matchStatus).toBe('matched');
    expect(matched!.matchedReceiptNumber).toBe(receipt.receiptNumber);
  });

  it('will not let a matched line be set aside', async () => {
    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, {}),
    );
    const matched = lines.find((l) => l.matchStatus === 'matched')!;

    await expect(
      as(org.adminUserId, (tx) =>
        ignoreBankLine(tx, org.organisationId, org.adminUserId, {
          bankTransactionId: matched.id,
          reason: 'Trying to set aside something already receipted.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('sets a line aside with a reason, and can put it back', async () => {
    const lines = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, {}),
    );
    const charges = lines.find((l) => l.description === 'BANK CHARGES')!;

    await expect(
      as(org.adminUserId, (tx) =>
        ignoreBankLine(tx, org.organisationId, org.adminUserId, {
          bankTransactionId: charges.id, reason: 'no',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await as(org.adminUserId, (tx) =>
      ignoreBankLine(tx, org.organisationId, org.adminUserId, {
        bankTransactionId: charges.id,
        reason: 'Monthly bank charges, recorded as an expense instead.',
      }),
    );

    const unmatched = await as(org.adminUserId, (tx) =>
      listBankLines(tx, org.organisationId, { onlyUnmatched: true }),
    );
    expect(unmatched.some((l) => l.id === charges.id)).toBe(false);

    await as(org.adminUserId, (tx) =>
      reopenBankLine(tx, org.organisationId, org.adminUserId, {
        bankTransactionId: charges.id,
      }),
    );
    const reopened = await as(org.adminUserId, (tx) =>
      getBankLine(tx, org.organisationId, charges.id),
    );
    expect(reopened!.matchStatus).toBe('unmatched');
  });

  /* --------------------------------------------------------- isolation */

  it('does not show one organisation another organisation\'s statement', async () => {
    const other = await createOrganisation('Elsewhere Bank');
    const lines = await as(other.adminUserId, (tx) =>
      listBankLines(tx, other.organisationId, {}),
    );
    expect(lines).toHaveLength(0);

    const imports = await as(other.adminUserId, (tx) =>
      listBankImports(tx, other.organisationId),
    );
    expect(imports).toHaveLength(0);
  });

  it('refuses to import against another organisation\'s bank account', async () => {
    const other = await createOrganisation('Elsewhere Bank Two');
    await expect(
      as(other.adminUserId, (tx) =>
        importStatement(tx, other.organisationId, other.adminUserId, {
          // A real account id, supplied by a caller who has no business with it.
          bankAccountId, csv: 'Date,Description,Amount\n01/03/2026,TEST,100.00',
          filename: 'theirs.csv',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
