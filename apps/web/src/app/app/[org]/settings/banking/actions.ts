'use server';

import { revalidatePath } from 'next/cache';
import {
  addBankAccount, changeBankAccountNumber, setBankAccountActive,
  updateBankAccountDetails, verifyBankAccount,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Banking detail commands.
 *
 * Every one of these is a thin shell: the permission, the fresh-authentication
 * requirement, the reason, the history row and the audit event are all enforced
 * in the domain, under the caller's own RLS context. Nothing here decides
 * anything, which is the point — a rule that lives in a Server Action is a rule
 * a second caller can skip.
 *
 * `reauthentication_required` travels back as its own error code so the form
 * can offer the re-verification page instead of saying "something went wrong".
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function addBankAccountAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return addBankAccount(tx, context.organisationId, viewer.authUserId, {
      label: str(formData, 'label'),
      bankName: str(formData, 'bankName'),
      accountHolder: str(formData, 'accountHolder'),
      accountNumber: str(formData, 'accountNumber'),
      branchCode: str(formData, 'branchCode') || undefined,
      accountRole: str(formData, 'accountRole') === 'deposit' ? 'deposit' : 'operating',
      reason: str(formData, 'reason'),
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/banking`);
  return result;
}

export async function changeBankAccountNumberAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return changeBankAccountNumber(tx, context.organisationId, viewer.authUserId, {
      bankAccountId: str(formData, 'bankAccountId'),
      accountNumber: str(formData, 'accountNumber'),
      reason: str(formData, 'reason'),
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/banking`);
  return result;
}

export async function updateBankAccountDetailsAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await updateBankAccountDetails(tx, context.organisationId, viewer.authUserId, {
      bankAccountId: str(formData, 'bankAccountId'),
      label: str(formData, 'label'),
      bankName: str(formData, 'bankName'),
      accountHolder: str(formData, 'accountHolder'),
      branchCode: str(formData, 'branchCode') || undefined,
      reason: str(formData, 'reason'),
    });
    return { updated: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/banking`);
  return result;
}

export async function verifyBankAccountAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await verifyBankAccount(tx, context.organisationId, viewer.authUserId, {
      bankAccountId: str(formData, 'bankAccountId'),
      method: str(formData, 'method'),
      note: str(formData, 'note') || undefined,
      reason: str(formData, 'reason'),
    });
    return { verified: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/banking`);
  return result;
}

export async function setBankAccountActiveAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await setBankAccountActive(tx, context.organisationId, viewer.authUserId, {
      bankAccountId: str(formData, 'bankAccountId'),
      active: str(formData, 'active') === 'yes',
      reason: str(formData, 'reason'),
    });
    return { done: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/settings/banking`);
  return result;
}
