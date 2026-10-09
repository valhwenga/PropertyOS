'use server';

import { revalidatePath } from 'next/cache';
import {
  approveDepositPayout, closeDepositAccount, creditDepositInterest, parseMajorToMinor,
  recordDepositReceipt,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Deposit commands.
 *
 * Every control lives in the domain and the database: the approver who is not
 * the requester, the evidence behind a deduction, the evidence behind interest,
 * the refusal to pay out more than is held. Nothing is re-decided here, and in
 * particular nothing here nets a deposit against rent — a deposit is a
 * liability and the two never meet.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function recordDepositReceiptAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return recordDepositReceipt(tx, context.organisationId, viewer.authUserId, {
      leaseId: str(formData, 'leaseId'),
      amountMinor: parseMajorToMinor(str(formData, 'amount'), context.currencyCode),
      receivedOn: str(formData, 'receivedOn'),
      holder: (str(formData, 'holder') || 'landlord') as
        'landlord' | 'agency_trust' | 'third_party_custodian',
      holderReference: str(formData, 'holderReference') || undefined,
      bankReference: str(formData, 'bankReference') || undefined,
      description: str(formData, 'description') || undefined,
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/deposits`);
  return result;
}

export async function creditDepositInterestAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const depositAccountId = str(formData, 'depositAccountId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await creditDepositInterest(tx, context.organisationId, viewer.authUserId, {
      depositAccountId,
      amountMinor: parseMajorToMinor(str(formData, 'amount'), context.currencyCode),
      effectiveOn: str(formData, 'effectiveOn'),
      evidenceDocumentId: str(formData, 'evidenceDocumentId'),
      basis: str(formData, 'basis') as 'bank_statement_evidence' | 'agreed_reviewed_calculation',
      description: str(formData, 'description') || undefined,
    });
    return { credited: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/deposits/${depositAccountId}`);
  return result;
}

/**
 * Approving a deduction, refund or transfer.
 *
 * `requestedByUserId` comes from the form because somebody else raised it;
 * the approver is always the signed-in actor and is never supplied. The domain
 * refuses when the two match, and the database refuses independently, so there
 * is no path where one person is both.
 */
export async function approveDepositPayoutAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const depositAccountId = str(formData, 'depositAccountId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await approveDepositPayout(tx, context.organisationId, viewer.authUserId, {
      depositAccountId,
      kind: str(formData, 'kind') as 'deduction' | 'refund' | 'transfer_to_rent',
      amountMinor: parseMajorToMinor(str(formData, 'amount'), context.currencyCode),
      effectiveOn: str(formData, 'effectiveOn'),
      description: str(formData, 'description'),
      evidenceDocumentId: str(formData, 'evidenceDocumentId'),
      requestedByUserId: str(formData, 'requestedByUserId'),
      approvalReason: str(formData, 'approvalReason'),
      refundReference: str(formData, 'refundReference') || undefined,
    });
    return { approved: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/deposits/${depositAccountId}`);
  return result;
}

export async function closeDepositAccountAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const depositAccountId = str(formData, 'depositAccountId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await closeDepositAccount(tx, context.organisationId, viewer.authUserId, {
      depositAccountId,
      closedOn: str(formData, 'closedOn'),
      reason: str(formData, 'reason'),
    });
    return { closed: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/deposits/${depositAccountId}`);
  return result;
}
