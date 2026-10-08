'use server';

import { revalidatePath } from 'next/cache';
import {
  DomainError, formatDayMonthYear, generateLeaseAgreement, parseDayMonthYear, parseMajorToMinor, registerDocument, renderLeaseAgreementPdf, saveLeaseAgreementTerms, sha256, shareDocument,
} from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';
import { notifyLeaseResidents } from '@/lib/lease-notices';

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
  /**
   * Dates arrive as dd/mm/yyyy, because that is what the field shows. Parsing
   * here means an unreadable date stops the save rather than reaching a `date`
   * column where the server's DateStyle would decide what the person meant.
   */
  const date = (k: string, label: string) => {
    const v = String(formData.get(k) ?? '').trim();
    if (v === '') return undefined;
    const iso = parseDayMonthYear(v);
    if (!iso) throw new DomainError('validation_failed', `${label} must be dd/mm/yyyy, for example 31/10/2026.`);
    return iso;
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
      keyReturnAt: date('keyReturnAt', 'Key return date'),
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
      (body, missing, reference, summary) =>
        renderLeaseAgreementPdf(body, {
          title: 'Lease Agreement',
          organisationName: context.organisationName,
          leaseReference: reference,
          generatedOn: formatDayMonthYear(new Date()),
          missingFields: missing,
          summary,
        }),
      async (bytes, filename, title, supersedesDocumentId) => {
        const registered = await registerDocument(
          tx, context.organisationId, viewer.authUserId,
          {
            classification: 'lease',
            title,
            filename,
            contentType: 'application/pdf',
            byteSize: bytes.byteLength,
            contentSha256: sha256(bytes),
            leaseId,
            supersedesDocumentId,
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

/**
 * Sends a generated agreement to the resident, or takes it back.
 *
 * Generated agreements are internal by default, which is right — nobody should
 * see a draft the moment it exists. But until now nothing connected generating
 * to sharing, so an agreement the tenant needed sat where only staff could see
 * it. The domain refuses to share anything quarantined or not linked to a
 * lease, so this is a visibility change and nothing more.
 */
export async function shareAgreementAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));
  const documentId = String(formData.get('documentId'));
  const share = String(formData.get('share')) === 'yes';

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await shareDocument(tx, context.organisationId, viewer.authUserId, {
      documentId,
      visibility: share ? 'resident_shared' : 'internal',
    });
    if (!share) {
      return {
        shared: false, inbox: 0, email: 'not attempted' as const,
        emailDetail: null, overrodePreference: 0,
      };
    }

    // Who to tell: the people with a live portal link to this lease. A resident
    // with no portal account gets no notice, and the result says so rather than
    // implying one was delivered.
    const delivery = await notifyLeaseResidents(tx, context.organisationId, {
      leaseId,
      templateKey: 'lease.agreement.shared',
      title: 'Your lease agreement is available',
      body: 'Your landlord has shared your lease agreement. You can read and download it '
        + 'from your documents.',
      linkPath: `/portal/${leaseId}`,
      email: {
        subject: 'Your lease agreement is available',
        body: 'Your landlord has shared your lease agreement with you. '
          + 'Sign in to PropertyOS to read and download it.',
      },
    });

    return { shared: true, ...delivery };
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}
