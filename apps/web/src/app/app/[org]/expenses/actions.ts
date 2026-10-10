'use server';

import { revalidatePath } from 'next/cache';
import {
  approveExpense, createVendor, parseMajorToMinor, payExpense, recordExpense,
  updateDraftExpense, voidExpense,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Expense commands.
 *
 * Recording needs `expense.record`; approving, paying and voiding need
 * `expense.approve`. That split is the whole point: §4 puts drafting with the
 * preparer and posting with the approver, and a cost that posts the moment
 * somebody types it has no approval step at all.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

type Category =
  | 'repairs_maintenance' | 'municipal' | 'insurance' | 'levies' | 'security'
  | 'cleaning' | 'management' | 'capital_improvement' | 'financing' | 'other';
type CostClass = 'operating' | 'capital' | 'financing' | 'owner_drawing';

function expenseFields(formData: FormData, currency: string) {
  return {
    propertyId: str(formData, 'propertyId') || undefined,
    vendorId: str(formData, 'vendorId') || undefined,
    category: (str(formData, 'category') || 'other') as Category,
    costClass: (str(formData, 'costClass') || 'operating') as CostClass,
    description: str(formData, 'description'),
    amountMinor: parseMajorToMinor(str(formData, 'amount'), currency),
    expenseDate: str(formData, 'expenseDate'),
    invoiceReference: str(formData, 'invoiceReference') || undefined,
    invoiceDocumentId: str(formData, 'invoiceDocumentId') || undefined,
  };
}

export async function recordExpenseAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return recordExpense(
      tx, context.organisationId, viewer.authUserId,
      expenseFields(formData, context.currencyCode),
    );
  });
  if (result.ok) revalidatePath(`/app/${org}/expenses`);
  return result;
}

export async function updateDraftExpenseAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const expenseId = str(formData, 'expenseId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await updateDraftExpense(tx, context.organisationId, viewer.authUserId, {
      expenseId, ...expenseFields(formData, context.currencyCode),
    });
    return { updated: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/expenses/${expenseId}`);
  return result;
}

export async function approveExpenseAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const expenseId = str(formData, 'expenseId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await approveExpense(tx, context.organisationId, viewer.authUserId, {
      expenseId, postingDate: str(formData, 'postingDate') || undefined,
    });
    return { approved: true };
  });
  if (result.ok) {
    revalidatePath(`/app/${org}/expenses/${expenseId}`);
    revalidatePath(`/app/${org}/expenses`);
  }
  return result;
}

export async function payExpenseAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const expenseId = str(formData, 'expenseId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await payExpense(tx, context.organisationId, viewer.authUserId, {
      expenseId, paidOn: str(formData, 'paidOn'),
      reference: str(formData, 'reference') || undefined,
    });
    return { paid: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/expenses/${expenseId}`);
  return result;
}

export async function voidExpenseAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const expenseId = str(formData, 'expenseId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await voidExpense(tx, context.organisationId, viewer.authUserId, {
      expenseId, reason: str(formData, 'reason'), postingDate: str(formData, 'postingDate'),
    });
    return { voided: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/expenses/${expenseId}`);
  return result;
}

export async function createVendorAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return createVendor(tx, context.organisationId, viewer.authUserId, {
      name: str(formData, 'name'),
      category: str(formData, 'category') || undefined,
      email: str(formData, 'email') || undefined,
      phone: str(formData, 'phone') || undefined,
      isContractor: str(formData, 'isContractor') === 'yes',
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/expenses`);
  return result;
}
