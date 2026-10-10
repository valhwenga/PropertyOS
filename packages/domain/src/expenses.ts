import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, notFound, parsed } from './errors';
import { postJournal, reverseJournal } from './ledger';
import type { Minor } from './money';
import { requirePermission } from './permissions';

/**
 * What a property costs.
 *
 * Four things this module is careful about, each because getting it wrong
 * misstates a number somebody relies on:
 *
 *  - OPERATING, CAPITAL, FINANCING AND OWNER DRAWINGS are different kinds of
 *    money (§11). Net operating income excludes the last three, so the class is
 *    recorded on every expense and never guessed from the category.
 *  - RECORDING IS NOT APPROVING, AND APPROVING IS NOT PAYING. A draft touches
 *    no ledger. Approval posts the cost against accounts payable. Payment moves
 *    it from payable to the bank. That is what lets §14's net operating income
 *    and cash surplus be different figures rather than the same one twice.
 *  - ONE INVOICE, ONE EXPENSE. §11: "A receipt must not be counted twice
 *    because it is attached to both a maintenance ticket and an expense." The
 *    database enforces it; this reports it readably.
 *  - A POSTED EXPENSE IS NOT EDITED. It is voided with a reason and its journal
 *    reversed, leaving both the original and the correction in the history.
 *
 * What this module does NOT do is split one cost across several properties.
 * §11 asks for recorded allocations and the schema carries a single
 * `property_id`, so a shared cost is recorded per property today. That is a
 * real gap, recorded in the reconciliation rather than papered over here.
 */

export type ExpenseCategory =
  | 'repairs_maintenance' | 'municipal' | 'insurance' | 'levies' | 'security'
  | 'cleaning' | 'management' | 'capital_improvement' | 'financing' | 'other';

export type CostClass = 'operating' | 'capital' | 'financing' | 'owner_drawing';

/** What each class means for net operating income, stated rather than implied. */
export const COST_CLASSES: Record<CostClass, string> = {
  operating: 'Operating — counts towards net operating income',
  capital: 'Capital improvement — excluded from net operating income',
  financing: 'Financing cost — excluded from net operating income',
  owner_drawing: 'Owner drawing — not a property cost at all',
};

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'repairs_maintenance', 'municipal', 'insurance', 'levies', 'security',
  'cleaning', 'management', 'capital_improvement', 'financing', 'other',
];

export interface ExpenseSummary {
  id: string;
  propertyId: string | null;
  propertyName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  category: ExpenseCategory;
  costClass: CostClass;
  costClassLabel: string;
  description: string;
  amountMinor: Minor;
  currencyCode: string;
  expenseDate: string;
  invoiceReference: string | null;
  invoiceDocumentId: string | null;
  workOrderId: string | null;
  status: 'draft' | 'approved' | 'posted' | 'paid' | 'void';
  approvedByName: string | null;
  approvedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

const expenseSchema = z.object({
  propertyId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  category: z.enum([
    'repairs_maintenance', 'municipal', 'insurance', 'levies', 'security',
    'cleaning', 'management', 'capital_improvement', 'financing', 'other',
  ]),
  costClass: z.enum(['operating', 'capital', 'financing', 'owner_drawing']).default('operating'),
  description: z.string().trim().min(3, 'Say what this is for.').max(500),
  amountMinor: z.bigint().positive(),
  expenseDate: z.string().date(),
  invoiceReference: z.string().trim().max(120).optional(),
  invoiceDocumentId: z.string().uuid().optional(),
  workOrderId: z.string().uuid().optional(),
});

const reasonSchema = z.string().trim().min(5, 'Say why, in a sentence.').max(500);

/* ------------------------------------------------------------------ reading */

export async function listExpenses(
  tx: Sql, organisationId: string, filters: { status?: string; propertyId?: string } = {},
): Promise<ExpenseSummary[]> {
  await requirePermission(tx, organisationId, 'report.read');
  const rows = await tx<Record<string, string | null>[]>`
    select e.id, e.property_id, e.vendor_id, e.category, e.cost_class, e.description,
           e.amount_minor::text, e.currency_code, e.expense_date::text, e.invoice_reference,
           e.invoice_document_id, e.work_order_id, e.status, e.approved_at::text,
           e.created_at::text,
           p.name as property_name, v.name as vendor_name,
           approver.full_name as approved_by_name,
           creator.full_name as created_by_name
      from expenses e
      left join properties p on p.id = e.property_id
      left join vendors v on v.id = e.vendor_id
      left join user_profiles approver on approver.auth_user_id = e.approved_by
      left join user_profiles creator on creator.auth_user_id = e.created_by
     where e.organisation_id = ${organisationId}::uuid
       ${filters.status ? tx`and e.status = ${filters.status}` : tx``}
       ${filters.propertyId ? tx`and e.property_id = ${filters.propertyId}::uuid` : tx``}
     order by e.expense_date desc, e.created_at desc
     limit 500
  `;
  return rows.map((r) => ({
    id: r.id!,
    propertyId: r.property_id ?? null,
    propertyName: r.property_name ?? null,
    vendorId: r.vendor_id ?? null,
    vendorName: r.vendor_name ?? null,
    category: r.category as ExpenseCategory,
    costClass: r.cost_class as CostClass,
    costClassLabel: COST_CLASSES[r.cost_class as CostClass],
    description: r.description!,
    amountMinor: BigInt(r.amount_minor!),
    currencyCode: r.currency_code!,
    expenseDate: r.expense_date!,
    invoiceReference: r.invoice_reference ?? null,
    invoiceDocumentId: r.invoice_document_id ?? null,
    workOrderId: r.work_order_id ?? null,
    status: r.status as ExpenseSummary['status'],
    approvedByName: r.approved_by_name ?? null,
    approvedAt: r.approved_at ?? null,
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at!,
  }));
}

export async function getExpense(
  tx: Sql, organisationId: string, expenseId: string,
): Promise<ExpenseSummary | undefined> {
  const all = await listExpenses(tx, organisationId);
  return all.find((e) => e.id === expenseId);
}

export async function listVendors(
  tx: Sql, organisationId: string,
): Promise<{ id: string; name: string; category: string | null; isContractor: boolean }[]> {
  await requirePermission(tx, organisationId, 'report.read');
  const rows = await tx<{ id: string; name: string; category: string | null; is_contractor: boolean }[]>`
    select id, name, category, is_contractor from vendors
     where organisation_id = ${organisationId}::uuid
     order by name
  `;
  return rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, isContractor: r.is_contractor,
  }));
}

export async function createVendor(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { name: string; category?: string; email?: string; phone?: string; isContractor?: boolean },
): Promise<{ vendorId: string }> {
  await requirePermission(tx, organisationId, 'expense.record');
  const d = parsed(z.object({
    name: z.string().trim().min(2).max(160),
    category: z.string().trim().max(80).optional(),
    email: z.string().trim().email().optional().or(z.literal('')),
    phone: z.string().trim().max(40).optional(),
    isContractor: z.boolean().default(false),
  }), input);

  const [row] = await tx<{ id: string }[]>`
    insert into vendors (organisation_id, name, category, email, phone, is_contractor)
    values (${organisationId}, ${d.name}, ${d.category ?? null},
            ${d.email || null}, ${d.phone ?? null}, ${d.isContractor})
    returning id
  `;
  if (!row) throw new DomainError('internal', 'Vendor insert returned no row.');
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'vendor.created', resourceType: 'vendor', resourceId: row.id,
    after: { name: d.name },
  });
  return { vendorId: row.id };
}

/* ------------------------------------------------------------------ writing */

/**
 * Records a cost as a draft.
 *
 * Touches no ledger: §4 puts "draft charges and expenses" with the preparer and
 * posting with the approver, so recording one must be safe for somebody who
 * cannot approve anything.
 */
export async function recordExpense(
  tx: Sql, organisationId: string, actorUserId: string,
  input: z.input<typeof expenseSchema>,
): Promise<{ expenseId: string }> {
  await requirePermission(tx, organisationId, 'expense.record');
  const d = parsed(expenseSchema, input);

  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
     where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw notFound('Financial book');

  try {
    const [row] = await tx<{ id: string }[]>`
      insert into expenses (
        organisation_id, book_id, property_id, vendor_id, category, cost_class,
        description, amount_minor, currency_code, expense_date, invoice_reference,
        invoice_document_id, work_order_id, status, created_by
      ) values (
        ${organisationId}, ${book.id}, ${d.propertyId ?? null}, ${d.vendorId ?? null},
        ${d.category}, ${d.costClass}, ${d.description}, ${d.amountMinor.toString()},
        ${book.currency_code}, ${d.expenseDate}, ${d.invoiceReference ?? null},
        ${d.invoiceDocumentId ?? null}, ${d.workOrderId ?? null}, 'draft', ${actorUserId}
      )
      returning id
    `;
    if (!row) throw new DomainError('internal', 'Expense insert returned no row.');

    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'expense.recorded', resourceType: 'expense', resourceId: row.id,
      after: {
        amountMinor: d.amountMinor.toString(), category: d.category,
        costClass: d.costClass, propertyId: d.propertyId ?? null,
      },
    });
    return { expenseId: row.id };
  } catch (error) {
    throw asExpenseError(error);
  }
}

/** Turns the duplicate-invoice index into something an operator can act on. */
function asExpenseError(error: unknown): unknown {
  const e = error as { code?: string; constraint_name?: string };
  if (e?.code === '23505' && e.constraint_name === 'expenses_one_per_invoice_document') {
    return new DomainError(
      'duplicate',
      'That invoice is already recorded as an expense. Counting it again would double the '
        + 'cost — open the existing one, or void it first if it was wrong.',
    );
  }
  if (error instanceof DomainError) return error;
  return fromDatabaseError(error);
}

async function lockExpense(
  tx: Sql, organisationId: string, expenseId: string,
): Promise<{
  id: string; book_id: string; currency_code: string; status: string;
  amount_minor: string; property_id: string | null; journal_id: string | null;
  description: string; expense_date: string;
}> {
  const [row] = await tx<{
    id: string; book_id: string; currency_code: string; status: string;
    amount_minor: string; property_id: string | null; journal_id: string | null;
    description: string; expense_date: string;
  }[]>`
    select id, book_id, currency_code, status, amount_minor::text, property_id,
           journal_id, description, expense_date::text
      from expenses
     where id = ${expenseId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!row) throw notFound('Expense');
  return row;
}

/**
 * Approves a draft and posts the cost.
 *
 *   debit  Property operating expense
 *   credit Accounts payable
 *
 * The cost is now in net operating income and the obligation is on the balance
 * sheet, which is correct whether or not anyone has paid it yet.
 */
export async function approveExpense(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { expenseId: string; postingDate?: string },
): Promise<{ journalId: string }> {
  await requirePermission(tx, organisationId, 'expense.approve');
  const expense = await lockExpense(tx, organisationId, input.expenseId);

  if (expense.status !== 'draft') {
    throw new DomainError(
      'conflict',
      `This expense is already ${expense.status}. Only a draft can be approved.`,
    );
  }

  try {
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: expense.book_id,
      currencyCode: expense.currency_code,
      postingDate: input.postingDate ?? expense.expense_date,
      source: 'expense',
      description: expense.description,
      sourceTable: 'expenses',
      sourceId: expense.id,
      postedBy: actorUserId,
      lines: [
        {
          accountRole: 'property_expense', debitMinor: BigInt(expense.amount_minor),
          propertyId: expense.property_id, memo: expense.description,
        },
        {
          accountRole: 'accounts_payable', creditMinor: BigInt(expense.amount_minor),
          propertyId: expense.property_id, memo: expense.description,
        },
      ],
    });

    await tx`
      update expenses
         set status = 'posted', approved_by = ${actorUserId}, approved_at = now(),
             journal_id = ${journalId}
       where id = ${input.expenseId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'expense.approved', resourceType: 'expense', resourceId: input.expenseId,
      after: { journalId, amountMinor: expense.amount_minor },
    });
    return { journalId };
  } catch (error) {
    throw asExpenseError(error);
  }
}

/**
 * Records that an approved expense was actually paid.
 *
 *   debit  Accounts payable
 *   credit Landlord bank control
 *
 * Separate from approval because they answer different questions: what the
 * property cost, and what has left the bank.
 */
export async function payExpense(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { expenseId: string; paidOn: string; reference?: string },
): Promise<{ journalId: string }> {
  await requirePermission(tx, organisationId, 'expense.approve');
  const expense = await lockExpense(tx, organisationId, input.expenseId);

  if (expense.status !== 'posted') {
    throw new DomainError(
      'conflict',
      expense.status === 'paid'
        ? 'This expense is already recorded as paid.'
        : 'Only an approved expense can be paid. Approve it first.',
    );
  }

  try {
    const journalId = await postJournal(tx, {
      organisationId,
      bookId: expense.book_id,
      currencyCode: expense.currency_code,
      postingDate: input.paidOn,
      source: 'expense',
      description: `${expense.description} — paid${input.reference ? ` (${input.reference})` : ''}`,
      sourceTable: 'expenses',
      sourceId: expense.id,
      postedBy: actorUserId,
      lines: [
        {
          accountRole: 'accounts_payable', debitMinor: BigInt(expense.amount_minor),
          propertyId: expense.property_id, memo: expense.description,
        },
        {
          accountRole: 'bank_control', creditMinor: BigInt(expense.amount_minor),
          propertyId: expense.property_id, memo: input.reference ?? expense.description,
        },
      ],
    });

    await tx`
      update expenses set status = 'paid'
       where id = ${input.expenseId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'expense.paid', resourceType: 'expense', resourceId: input.expenseId,
      after: { journalId, paidOn: input.paidOn, reference: input.reference ?? null },
    });
    return { journalId };
  } catch (error) {
    throw asExpenseError(error);
  }
}

/**
 * Voids an expense, reversing whatever it posted.
 *
 * A posted cost is never edited or deleted. Voiding leaves the original journal
 * and its reversal both in the ledger, which is the difference between a
 * correction and a cover-up.
 */
export async function voidExpense(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { expenseId: string; reason: string; postingDate: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'expense.approve');
  const reason = parsed(reasonSchema, input.reason);
  const expense = await lockExpense(tx, organisationId, input.expenseId);

  if (expense.status === 'void') {
    throw new DomainError('conflict', 'This expense is already void.');
  }
  if (expense.status === 'paid') {
    throw new DomainError(
      'conflict',
      'This expense has been paid. Voiding it would say the money never left the account. '
        + 'Record the refund or credit note you actually received instead.',
    );
  }

  if (expense.journal_id) {
    await reverseJournal(tx, {
      organisationId,
      journalId: expense.journal_id,
      reason,
      postingDate: input.postingDate,
      postedBy: actorUserId,
    });
  }

  await tx`
    update expenses set status = 'void'
     where id = ${input.expenseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'expense.voided', resourceType: 'expense', resourceId: input.expenseId,
    reason, before: { status: expense.status },
  });
}

/** A draft that was wrong in its details, before anything was posted. */
export async function updateDraftExpense(
  tx: Sql, organisationId: string, actorUserId: string,
  input: z.input<typeof expenseSchema> & { expenseId: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'expense.record');
  const d = parsed(expenseSchema, input);
  const expense = await lockExpense(tx, organisationId, input.expenseId);

  if (expense.status !== 'draft') {
    throw new DomainError(
      'conflict',
      'Only a draft can be edited. A posted expense is corrected by voiding it and recording '
        + 'the right one, so both stay in the history.',
    );
  }
  try {
    await tx`
      update expenses
         set property_id = ${d.propertyId ?? null}, vendor_id = ${d.vendorId ?? null},
             category = ${d.category}, cost_class = ${d.costClass},
             description = ${d.description}, amount_minor = ${d.amountMinor.toString()},
             expense_date = ${d.expenseDate}, invoice_reference = ${d.invoiceReference ?? null},
             invoice_document_id = ${d.invoiceDocumentId ?? null},
             work_order_id = ${d.workOrderId ?? null}
       where id = ${input.expenseId}::uuid and organisation_id = ${organisationId}::uuid
    `;
  } catch (error) {
    throw asExpenseError(error);
  }

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'expense.updated', resourceType: 'expense', resourceId: input.expenseId,
    before: { amountMinor: expense.amount_minor },
    after: { amountMinor: d.amountMinor.toString(), costClass: d.costClass },
  });
}
