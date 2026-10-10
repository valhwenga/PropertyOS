'use server';

import { revalidatePath } from 'next/cache';
import {
  allocateReceipt, confirmReceipt, identifySuspenseReceipt, parseMajorToMinor,
  reverseAllocation, reviewPaymentEvidence, suggestAllocation,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * The receipt workflow's commands.
 *
 * Every financial rule is in the domain: the permission, the over-allocation
 * guard, the suspense movement, the reversal journal and the invariant that
 * proof of payment never moves a balance. Nothing is re-decided here. In
 * particular the allocation amounts are parsed into minor units and handed
 * straight on — no arithmetic happens in this file, because money arithmetic
 * spread across two layers is money arithmetic that will disagree with itself.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

/** Reads the per-charge amounts an operator typed, skipping the blanks. */
function allocationsFrom(formData: FormData, currency: string) {
  const out: { chargeLineId: string; amountMinor: bigint }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('amount:')) continue;
    const raw = String(value).trim();
    if (raw === '' || raw === '0') continue;
    out.push({
      chargeLineId: key.slice('amount:'.length),
      amountMinor: parseMajorToMinor(raw, currency),
    });
  }
  return out;
}

export async function recordReceiptAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const leaseId = str(formData, 'leaseId');
    return confirmReceipt(tx, context.organisationId, viewer.authUserId, {
      // No lease means the payer is not identified, and the domain puts the
      // money in suspense rather than guessing.
      leaseId: leaseId || undefined,
      amountMinor: parseMajorToMinor(str(formData, 'amount'), context.currencyCode),
      feeMinor: str(formData, 'fee')
        ? parseMajorToMinor(str(formData, 'fee'), context.currencyCode)
        : 0n,
      receivedOn: str(formData, 'receivedOn'),
      method: (str(formData, 'method') || 'eft') as 'eft' | 'cash' | 'card' | 'debit_order' | 'other',
      payerReference: str(formData, 'payerReference') || undefined,
      notes: str(formData, 'notes') || undefined,
      // When the receipt was started from a statement line, the two are tied
      // together: `confirmReceipt` marks the line matched. Without this the
      // line would stay on the worklist beside the receipt it produced, and
      // somebody would eventually receipt it twice.
      bankTransactionId: str(formData, 'bankTransactionId') || undefined,
    });
  });
  if (result.ok) {
    revalidatePath(`/app/${org}/reconciliation`);
    revalidatePath(`/app/${org}/reconciliation/statements`);
  }
  return result;
}

/**
 * Applies a receipt to charges.
 *
 * `suggest` fills the form from the recorded policy without posting anything;
 * `apply` posts what the operator actually confirmed. Keeping them apart is the
 * blueprint's point that "a suggested match is not automatically final".
 */
export async function suggestAllocationAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  return command(async ({ tx }) => {
    const context = await requireOperator(org);
    const suggestion = await suggestAllocation(tx, context.organisationId, {
      leaseId: str(formData, 'leaseId'),
      amountMinor: parseMajorToMinor(str(formData, 'unapplied'), context.currencyCode),
    });
    return {
      policy: suggestion.policy,
      remainingMinor: suggestion.remainingMinor.toString(),
      allocations: suggestion.allocations.map((a) => ({
        chargeLineId: a.chargeLineId,
        amountMinor: a.amountMinor.toString(),
      })),
    };
  });
}

export async function applyAllocationAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const receiptId = str(formData, 'receiptId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const allocations = allocationsFrom(formData, context.currencyCode);
    const applied = await allocateReceipt(tx, context.organisationId, viewer.authUserId, {
      receiptId,
      postingDate: str(formData, 'postingDate'),
      // 'manual' whenever an operator confirmed the amounts themselves, which
      // is always here: the suggestion only fills the form in. The stored
      // policy affects arrears ageing, so it must say what actually happened.
      policy: 'manual',
      allocations,
    });
    return {
      allocatedMinor: applied.allocatedMinor.toString(),
      unappliedMinor: applied.unappliedMinor.toString(),
      count: applied.allocationIds.length,
    };
  });
  if (result.ok) revalidatePath(`/app/${org}/reconciliation/${receiptId}`);
  return result;
}

export async function identifyReceiptAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const receiptId = str(formData, 'receiptId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await identifySuspenseReceipt(tx, context.organisationId, viewer.authUserId, {
      receiptId,
      leaseId: str(formData, 'leaseId'),
      postingDate: str(formData, 'postingDate'),
      reason: str(formData, 'reason'),
    });
    return { identified: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/reconciliation/${receiptId}`);
  return result;
}

export async function reverseAllocationAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const receiptId = str(formData, 'receiptId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await reverseAllocation(tx, context.organisationId, viewer.authUserId, {
      allocationId: str(formData, 'allocationId'),
      postingDate: str(formData, 'postingDate'),
      reason: str(formData, 'reason'),
    });
    return { reversed: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/reconciliation/${receiptId}`);
  return result;
}

export async function reviewEvidenceAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await reviewPaymentEvidence(tx, context.organisationId, viewer.authUserId, {
      evidenceId: str(formData, 'evidenceId'),
      outcome: str(formData, 'outcome') as 'accepted' | 'rejected' | 'under_review',
      note: str(formData, 'note') || undefined,
      receiptId: str(formData, 'receiptId') || undefined,
    });
    return { reviewed: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/reconciliation`);
  return result;
}
