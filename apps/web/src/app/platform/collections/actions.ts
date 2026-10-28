'use server';

import { revalidatePath } from 'next/cache';
import {
  abandonCollection, collectionForSubmission, markCollectionSubmitted,
  openMandateAccountNumber, prepareCollections,
} from '@propertyos/domain';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { command } from '@/lib/actions';
import { log } from '@/lib/logger';

/**
 * The debit order run, and handing one instruction to the bank.
 *
 * Both privileged: `subscription_collections` has no insert or update policy
 * for the application role at all, because an instruction to take money out of
 * somebody's account is not something a web request should be able to write
 * under its own authority. The permission is still checked in SQL, inside the
 * domain functions, against the caller's own identity.
 */
export async function prepareCollectionsAction(_previous: unknown, formData: FormData) {
  const actionDate = String(formData.get('actionDate') ?? '');
  const result = await command(({ tx, viewer }) =>
    prepareCollections(tx, viewer.authUserId, { actionDate }), { privileged: true });
  if (result.ok) revalidatePath('/platform/collections');
  return result;
}

/**
 * Submitting one.
 *
 * The account number is opened here, held for the length of one call, and
 * handed to the provider — the only place in this product it travels in full.
 * It is not logged, not returned, and not put in the audit entry.
 *
 * The order matters: the provider is called BEFORE the row is marked
 * submitted, because a row that says submitted when nothing was sent is a
 * collection nobody will ever chase, while a provider that accepted an
 * instruction we failed to record is visible as a duplicate when the outcome
 * arrives for a reference we still think is prepared.
 */
export async function submitCollectionAction(_previous: unknown, formData: FormData) {
  const collectionId = String(formData.get('collectionId') ?? '');
  const provider = resolvePaymentProvider();
  if (!provider.available) {
    return {
      ok: false as const,
      message: `Nothing can be submitted: ${provider.unavailableReason}`,
    };
  }

  const loaded = await command(async ({ tx, viewer }) => {
    const detail = await collectionForSubmission(tx, viewer.authUserId, collectionId);
    if (!detail) return null;
    const accountNumber = await openMandateAccountNumber(tx, detail.mandateId);
    return { detail, accountNumber };
  }, { privileged: true });
  if (!loaded.ok) return loaded;

  const payload = (loaded as unknown as {
    detail: Awaited<ReturnType<typeof collectionForSubmission>>;
    accountNumber: string | null;
  });
  if (!payload.detail || !payload.accountNumber) {
    return { ok: false as const, message: 'That collection could not be read.' };
  }
  const { detail, accountNumber } = payload as {
    detail: NonNullable<Awaited<ReturnType<typeof collectionForSubmission>>>;
    accountNumber: string;
  };

  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  let providerReference: string;
  try {
    const submitted = await provider.submitCollection({
      reference: detail.collection.reference,
      mandateReference: detail.collection.mandateReference,
      providerMandateReference: detail.providerMandateReference,
      amountMinor: detail.collection.amountMinor,
      currencyCode: detail.collection.currencyCode,
      actionDate: detail.collection.actionDate,
      accountHolder: detail.accountHolder,
      bankName: detail.bankName,
      branchCode: detail.branchCode,
      accountType: detail.accountType,
      accountNumber,
      notifyUrl: `${base}/api/payments/${provider.name}/notify`,
    });
    providerReference = submitted.providerReference;
  } catch (error) {
    // Deliberately without the instruction in the log: it carries an account
    // number.
    log('error', 'collection could not be submitted', {
      reference: detail.collection.reference,
      provider: provider.name,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return {
      ok: false as const,
      message: 'The provider would not accept it. Nothing has been collected, and it is '
        + 'still prepared.',
    };
  }

  const recorded = await command(({ tx, viewer }) =>
    markCollectionSubmitted(tx, viewer.authUserId, { collectionId, providerReference })
      .then(() => ({ providerReference })), { privileged: true });
  if (recorded.ok) revalidatePath('/platform/collections');
  return recorded;
}

export async function abandonCollectionAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    abandonCollection(tx, viewer.authUserId, {
      collectionId: String(formData.get('collectionId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    }).then(() => ({})), { privileged: true });
  if (result.ok) revalidatePath('/platform/collections');
  return result;
}
