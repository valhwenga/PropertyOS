'use server';

import { revalidatePath } from 'next/cache';
import {
  DomainError, generateLeaseAgreement, parseMajorToMinor, registerDocument,
  renderLeaseAgreementPdf, saveLeaseAgreementTerms, sha256,
} from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

export async function saveTermsAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));
  const text = (k: string) => String(formData.get(k) ?? '').trim() || undefined;
  const num = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v === '' ? undefined : v;
  };
  /**
   * The form asks for rands; the column stores minor units. Converting here
   * keeps the storage format off the screen, and a value that is not an amount
   * is refused rather than coerced into one — a silently misread fee ends up in
   * a signed agreement.
   */
  const money = (k: string, label: string) => {
    const v = String(formData.get(k) ?? '').trim();
    if (v === '') return undefined;
    try {
      return Number(parseMajorToMinor(v, 'ZAR'));
    } catch {
      throw new DomainError('validation_failed', `${label} is not a valid amount.`);
    }
  };
  /** Unset stays unset. See the note on Choice in the panel. */
  const choice = (k: string) => {
    const v = String(formData.get(k) ?? '');
    return v === 'yes' ? true : v === 'no' ? false : undefined;
  };

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await saveLeaseAgreementTerms(tx, context.organisationId, viewer.authUserId, {
      leaseId,
      parkingBays: text('parkingBays'),
      maxOccupants: num('maxOccupants') as never,
      permanentVehicles: num('permanentVehicles') as never,
      smokingAllowed: choice('smokingAllowed'),
      petsAllowed: choice('petsAllowed'),
      petsDetail: text('petsDetail'),
      adminFeeMinor: money('adminFee', 'Admin fee') as never,
      creditCheckFeeMinor: money('creditCheckFee', 'Credit check fee') as never,
      arrearInterestMonthlyPercent: num('arrearInterestMonthlyPercent') as never,
      arrearInterestAnnualCapPercent: num('arrearInterestAnnualCapPercent') as never,
      renewalOptionMonths: num('renewalOptionMonths') as never,
      renewalNoticeMonths: num('renewalNoticeMonths') as never,
      paymentMethod: (text('paymentMethod') ?? undefined) as never,
      placeOfPayment: text('placeOfPayment'),
      jurisdictionCourt: text('jurisdictionCourt'),
      keyReturnAt: text('keyReturnAt'),
      surchargeDetail: text('surchargeDetail'),
      specialConditions: text('specialConditions'),
    });
    return { saved: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}

/**
 * Generates the agreement.
 *
 * The PDF is registered as a private document with its own provenance — bytes
 * PropertyOS authored, so not scanned and not quarantined, rather than labelled
 * clean by a scan that never ran.
 */
export async function generateAgreementAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));
  const templateId = String(formData.get('templateId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const storage = resolveStorageAdapter();

    const generated = await generateLeaseAgreement(
      tx, context.organisationId, viewer.authUserId, { leaseId, templateId },
      (body, missing, reference) =>
        renderLeaseAgreementPdf(body, {
          title: 'Lease Agreement',
          organisationName: context.organisationName,
          leaseReference: reference,
          generatedOn: new Date().toISOString().slice(0, 10),
          missingFields: missing,
        }),
      async (bytes, filename) => {
        const registered = await registerDocument(
          tx, context.organisationId, viewer.authUserId,
          {
            classification: 'lease',
            title: filename,
            filename,
            contentType: 'application/pdf',
            byteSize: bytes.byteLength,
            contentSha256: sha256(bytes),
            leaseId,
          },
          { status: 'system_generated', detail: 'Rendered by PropertyOS from a lease template.' },
        );
        await storage.put({
          key: registered.storageKey, body: bytes, contentType: 'application/pdf',
        });
        return { documentId: registered.documentId };
      },
    );

    return {
      documentId: generated.documentId,
      missingFields: generated.missingFields,
      unknownFields: generated.unknownFields,
    };
  });

  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}
