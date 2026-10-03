'use server';

import { revalidatePath } from 'next/cache';
import { createTicket, submitPaymentEvidence, parseMajorToMinor } from '@propertyos/domain';
import { DomainError } from '@propertyos/domain';
import { command } from '@/lib/actions';

/** Resolves the organisation from the viewer's OWN portal links, never from input. */
function organisationForLease(
  viewer: { residentLeases: Array<{ leaseId: string; organisationId: string }> },
  leaseId: string,
): string {
  const link = viewer.residentLeases.find((l) => l.leaseId === leaseId);
  if (!link) throw new DomainError('not_found', 'Lease not found.');
  return link.organisationId;
}

export async function submitMaintenanceRequest(_previous: unknown, formData: FormData) {
  const leaseId = String(formData.get('leaseId'));
  const category = String(formData.get('category'));
  const description = String(formData.get('description') ?? '');
  const location = String(formData.get('location') ?? '').trim();
  const urgency = String(formData.get('urgency') ?? 'normal');

  const result = await command(async ({ tx, viewer }) => {
    const organisationId = organisationForLease(viewer, leaseId);

    const [lease] = await tx<{ property_id: string; unit_id: string }[]>`
      select property_id, unit_id from leases where id = ${leaseId}::uuid
    `;
    if (!lease) throw new DomainError('not_found', 'Lease not found.');

    const [party] = await tx<{ resident_id: string }[]>`
      select lp.resident_id from lease_parties lp
      join portal_links pl on pl.resident_id = lp.resident_id and pl.lease_id = lp.lease_id
      where lp.lease_id = ${leaseId}::uuid and pl.auth_user_id = ${viewer.authUserId}::uuid
      limit 1
    `;

    return createTicket(tx, organisationId, viewer.authUserId, {
      propertyId: lease.property_id,
      unitId: lease.unit_id,
      leaseId,
      residentId: party?.resident_id,
      category: category as 'plumbing',
      description,
      location: location || undefined,
      urgency: urgency as 'normal',
    }, { asResident: true });
  });

  if (result.ok) revalidatePath(`/portal/${leaseId}`);
  return result;
}

export async function submitProofOfPayment(_previous: unknown, formData: FormData) {
  const leaseId = String(formData.get('leaseId'));
  const amount = String(formData.get('amount') ?? '');
  const paidAt = String(formData.get('paidAt') ?? '');
  const reference = String(formData.get('reference') ?? '').trim();

  const result = await command(async ({ tx, viewer }) => {
    const organisationId = organisationForLease(viewer, leaseId);
    let amountMinor: bigint;
    try {
      amountMinor = parseMajorToMinor(amount, 'ZAR');
    } catch {
      throw new DomainError('validation_failed', 'Enter the amount you paid, for example 1850.00');
    }
    if (amountMinor <= 0n) {
      throw new DomainError('validation_failed', 'The amount must be greater than zero.');
    }

    // Deliberately records evidence only. No receipt, no journal, no change to
    // the balance until an operator verifies the funds against the bank record.
    return submitPaymentEvidence(tx, organisationId, viewer.authUserId, {
      leaseId,
      claimedAmountMinor: amountMinor,
      claimedPaidAt: paidAt,
      reference: reference || undefined,
    });
  });

  if (result.ok) revalidatePath(`/portal/${leaseId}`);
  return result;
}
