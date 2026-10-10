/**
 * What a property costs, and what has actually left the bank.
 *
 * There was no expenses domain module: the table, its categories and its
 * cost classes have existed since 0006 with nothing able to write a row
 * except the CSV import. Approval and payment were separate statuses with no
 * account to hold the difference between them, so an approved-but-unpaid cost
 * had nowhere correct to go.
 *
 * Three things this suite is really about:
 *   - approving and paying are different events, and after approval alone the
 *     bank balance has not moved;
 *   - operating, capital, financing and owner drawings are different kinds of
 *     money and must not be added together into one "cost";
 *   - one invoice cannot be counted twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  approveExpense, assertBookBalances, createStandaloneHouse, createVendor,
  expenseReport, getExpense, listExpenses, parseMajorToMinor, payExpense,
  recordExpense, registerDocument, updateDraftExpense, voidExpense,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

/** The balance on an account resolved by its system role. */
async function roleBalance(bookId: string, role: string): Promise<bigint> {
  const [row] = await ownerSql()<{ balance: string }[]>`
    select coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text as balance
      from journal_lines jl
      join accounts a on a.id = jl.account_id
     where a.book_id = ${bookId} and a.system_role = ${role}
  `;
  return BigInt(row!.balance);
}

describe('Expenses', () => {
  let org: OrganisationFixture;
  let propertyId: string;
  let vendorId: string;
  let invoiceId: string;
  let preparer: string;

  beforeAll(async () => {
    org = await createOrganisation('Expense Co');
    preparer = await addMember(org.organisationId, 'Prep Arer', ['finance_preparer']);

    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: 'Expense House', code: 'EXP', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Johannesburg',
      }),
    );
    propertyId = house.propertyId;

    const vendor = await as(org.adminUserId, (tx) =>
      createVendor(tx, org.organisationId, org.adminUserId, {
        name: 'Cape Plumbing', category: 'plumbing', isContractor: true,
      }),
    );
    vendorId = vendor.vendorId;

    const doc = await as(org.adminUserId, (tx) =>
      registerDocument(
        tx, org.organisationId, org.adminUserId,
        {
          classification: 'invoice', title: 'Plumbing invoice 4471',
          filename: 'inv-4471.pdf', contentType: 'application/pdf',
          byteSize: 2048, contentSha256: 'c'.repeat(64), propertyId,
        },
        { status: 'clean', detail: 'Scanned clean in a test.' },
      ),
    );
    invoiceId = doc.documentId;
  });

  afterAll(async () => { await closeOwner(); });

  /* ------------------------------------------------- a draft touches nothing */

  it('records a draft without posting anything', async () => {
    const expenseBefore = await roleBalance(org.bookId, 'property_expense');

    const { expenseId } = await as(preparer, (tx) =>
      recordExpense(tx, org.organisationId, preparer, {
        propertyId, vendorId, category: 'repairs_maintenance', costClass: 'operating',
        description: 'Replace the geyser element', amountMinor: R('2400'),
        expenseDate: '2026-03-10', invoiceReference: 'INV-4471',
      }),
    );

    const expense = await as(org.adminUserId, (tx) =>
      getExpense(tx, org.organisationId, expenseId),
    );
    expect(expense!.status).toBe('draft');
    // Nothing has reached the ledger: a preparer who cannot approve must still
    // be able to record what arrived in the post.
    expect(await roleBalance(org.bookId, 'property_expense')).toBe(expenseBefore);
  });

  it('refuses to let a finance preparer approve their own expense', async () => {
    const [draft] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'draft' }),
    );
    await expect(
      as(preparer, (tx) => approveExpense(tx, org.organisationId, preparer, {
        expenseId: draft!.id,
      })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets a draft be corrected before it is posted', async () => {
    const [draft] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'draft' }),
    );
    await as(preparer, (tx) =>
      updateDraftExpense(tx, org.organisationId, preparer, {
        expenseId: draft!.id, propertyId, vendorId,
        category: 'repairs_maintenance', costClass: 'operating',
        description: 'Replace the geyser element and the thermostat',
        amountMinor: R('2650'), expenseDate: '2026-03-10', invoiceReference: 'INV-4471',
      }),
    );
    const expense = await as(org.adminUserId, (tx) =>
      getExpense(tx, org.organisationId, draft!.id),
    );
    expect(expense!.amountMinor).toBe(R('2650'));
  });

  /* ------------------------------------ approving is not paying */

  it('approving posts the cost against payables, not against the bank', async () => {
    const bankBefore = await roleBalance(org.bookId, 'bank_control');
    const [draft] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'draft' }),
    );

    await as(org.adminUserId, (tx) =>
      approveExpense(tx, org.organisationId, org.adminUserId, { expenseId: draft!.id }),
    );

    // The property now carries the cost…
    expect(await roleBalance(org.bookId, 'property_expense')).toBe(R('2650'));
    // …the obligation is on the balance sheet (a credit, so negative here)…
    expect(await roleBalance(org.bookId, 'accounts_payable')).toBe(-R('2650'));
    // …and not one cent has left the bank.
    expect(await roleBalance(org.bookId, 'bank_control')).toBe(bankBefore);

    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to approve the same expense twice', async () => {
    const [posted] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'posted' }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        approveExpense(tx, org.organisationId, org.adminUserId, { expenseId: posted!.id }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to edit an expense once it is posted', async () => {
    const [posted] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'posted' }),
    );
    await expect(
      as(preparer, (tx) =>
        updateDraftExpense(tx, org.organisationId, preparer, {
          expenseId: posted!.id, category: 'repairs_maintenance', costClass: 'operating',
          description: 'Quietly changed after posting', amountMinor: R('10'),
          expenseDate: '2026-03-10',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('paying moves it from payables to the bank', async () => {
    const [posted] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'posted' }),
    );
    await as(org.adminUserId, (tx) =>
      payExpense(tx, org.organisationId, org.adminUserId, {
        expenseId: posted!.id, paidOn: '2026-03-20', reference: 'EFT 4471',
      }),
    );

    expect(await roleBalance(org.bookId, 'accounts_payable')).toBe(0n);
    expect(await roleBalance(org.bookId, 'bank_control')).toBe(-R('2650'));
    // The cost itself has not changed: paying an invoice does not make the
    // property more expensive, it makes the bank emptier.
    expect(await roleBalance(org.bookId, 'property_expense')).toBe(R('2650'));
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });

  it('refuses to void an expense that has been paid', async () => {
    // Voiding would say the money never left the account. It did.
    const [paid] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'paid' }),
    );
    await expect(
      as(org.adminUserId, (tx) =>
        voidExpense(tx, org.organisationId, org.adminUserId, {
          expenseId: paid!.id, reason: 'Trying to undo a payment that happened.',
          postingDate: '2026-03-21',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  /* ------------------------------------------------ one invoice, one expense */

  it('refuses to expense the same invoice twice', async () => {
    await as(preparer, (tx) =>
      recordExpense(tx, org.organisationId, preparer, {
        propertyId, vendorId, category: 'repairs_maintenance', costClass: 'operating',
        description: 'Plumbing call-out', amountMinor: R('900'),
        expenseDate: '2026-04-01', invoiceDocumentId: invoiceId,
      }),
    );

    // §11: "A receipt must not be counted twice because it is attached to both
    // a maintenance ticket and an expense."
    await expect(
      as(preparer, (tx) =>
        recordExpense(tx, org.organisationId, preparer, {
          propertyId, vendorId, category: 'repairs_maintenance', costClass: 'operating',
          description: 'The same invoice again', amountMinor: R('900'),
          expenseDate: '2026-04-02', invoiceDocumentId: invoiceId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('allows the same invoice again once the first was voided', async () => {
    // An invoice expensed in error, voided, then recorded correctly is a
    // legitimate sequence; it is simultaneous double-counting that is refused.
    const [draft] = await as(org.adminUserId, (tx) =>
      listExpenses(tx, org.organisationId, { status: 'draft' }),
    );
    await as(org.adminUserId, (tx) =>
      voidExpense(tx, org.organisationId, org.adminUserId, {
        expenseId: draft!.id, reason: 'Recorded against the wrong property.',
        postingDate: '2026-04-02',
      }),
    );
    await expect(
      as(preparer, (tx) =>
        recordExpense(tx, org.organisationId, preparer, {
          propertyId, vendorId, category: 'repairs_maintenance', costClass: 'operating',
          description: 'Plumbing call-out, recorded correctly', amountMinor: R('900'),
          expenseDate: '2026-04-02', invoiceDocumentId: invoiceId,
        }),
      ),
    ).resolves.toMatchObject({ expenseId: expect.any(String) });
  });

  /* --------------------------------------------- classes are not interchangeable */

  it('keeps capital out of net operating income', async () => {
    await as(preparer, (tx) =>
      recordExpense(tx, org.organisationId, preparer, {
        propertyId, vendorId, category: 'capital_improvement', costClass: 'capital',
        description: 'New roof', amountMinor: R('85000'), expenseDate: '2026-05-01',
      }),
    );
    const report = await as(org.adminUserId, (tx) =>
      expenseReport(tx, org.organisationId, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }),
    );
    // A roof is not an operating cost. Adding it to one would make the property
    // look catastrophically unprofitable in the month it was replaced.
    expect(report.totalCapitalMinor).toBe(R('85000'));
    expect(report.totalOperatingMinor).not.toBe(report.totalMinor);
  });

  it('labels every cost class rather than leaving it as an enum', async () => {
    const expenses = await as(org.adminUserId, (tx) => listExpenses(tx, org.organisationId));
    const capital = expenses.find((e) => e.costClass === 'capital')!;
    expect(capital.costClassLabel).toBe('Capital improvement — excluded from net operating income');
  });

  /* ------------------------------------------------------------- isolation */

  it('does not show one organisation another organisation\'s costs', async () => {
    const other = await createOrganisation('Elsewhere Expenses');
    const expenses = await as(other.adminUserId, (tx) =>
      listExpenses(tx, other.organisationId),
    );
    expect(expenses).toEqual([]);
  });

  it('ends with a balanced ledger', async () => {
    await as(org.adminUserId, (tx) => assertBookBalances(tx, org.bookId));
  });
});
