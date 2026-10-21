'use server';

import { revalidatePath } from 'next/cache';
import {
  activateLease, expireLease, extendLease, invalid, parseDayMonthYear, parseMajorToMinor,
  renewLease, terminateLease,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';
import { notifyLeaseResidents } from '@/lib/lease-notices';

/**
 * Activating a lease: the step that turns a draft into a tenancy.
 *
 * `activateLease` has existed since the first milestone with **no screen
 * anywhere in this application**, so a lease drafted in the product stayed a
 * draft for ever: no rent schedule, nothing for the billing run to find, no
 * occupancy recorded, and a unit left unreserved. Every lease that has ever
 * been billed in this product was activated by the seed script or a test. The
 * leases list even told the reader "a draft has no billing effect until it is
 * activated", which was true and unachievable.
 *
 * The version is carried through the form as a compare-and-swap guard: two
 * people activating the same draft from two tabs must not both succeed, and
 * the second gets told the lease changed rather than silently winning.
 */
export async function activateLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const typedDate = String(formData.get('activationDate') ?? '').trim();
    const activationDate = parseDayMonthYear(typedDate);
    if (!activationDate) throw invalid('Enter the activation date as dd/mm/yyyy.');

    const documentId = String(formData.get('executedDocumentId') ?? '').trim();
    const exceptionReason = String(formData.get('executionExceptionReason') ?? '').trim();
    // The domain requires one of the two. Saying which is missing, in the words
    // of the screen, beats repeating its sentence about "activation requires".
    if (!documentId && !exceptionReason) {
      throw invalid(
        'Attach the signed lease, or say why it is being activated without one. '
          + 'Whichever you choose is recorded against the lease.',
      );
    }

    const outcome = await activateLease(tx, context.organisationId, viewer.authUserId, {
      leaseId,
      expectedVersion: Number(formData.get('expectedVersion') ?? '0'),
      activationDate,
      ...(documentId ? { executedDocumentId: documentId } : {}),
      ...(exceptionReason ? { executionExceptionReason: exceptionReason } : {}),
    });

    // No notice is sent, and none is claimed. There is no notification template
    // for an activation, and the resident learns about their tenancy from the
    // lease they signed rather than from this product — inventing a message
    // here would be inventing a channel the rest of the system does not have.
    return outcome;
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}

/**
 * Recording that a lease has run its course.
 *
 * `expireLease` existed with one test, no screen and no scheduled job, and
 * nothing else in the product writes the `expired` status — so a tenancy that
 * reached its end date stayed `active` for ever. Both demo leases will do
 * exactly that in December 2026 unless somebody says otherwise.
 *
 * It is NOT done automatically on the end date, and that is a decision rather
 * than laziness: whether the tenant actually left, or stayed on as a holdover,
 * is a fact about the world that only a person knows. A job that marked leases
 * expired at midnight would be guessing, and the guess would quietly end
 * somebody's occupancy record.
 */
export async function expireLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await expireLease(tx, context.organisationId, viewer.authUserId, {
      leaseId,
      // "Still there" is the holdover case the blueprint names: the term ended
      // and the occupant has not moved out. The occupancy interval stays open
      // and is marked, rather than being closed as though they had left.
      holdover: String(formData.get('holdover') ?? '') === 'yes',
    });
    return {};
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}

/**
 * Renewing a lease: a new term, as a draft successor.
 *
 * `renewLease` had **no references anywhere in this repository** — not a
 * screen, not a test — so the only way to continue a tenancy was to draft a
 * fresh lease by hand and lose the link between the two.
 *
 * The successor is a DRAFT on purpose. A renewal is an agreement, and the
 * product should not quietly reserve a unit and start billing a new rent
 * because somebody typed a number: it goes through the same activation step,
 * with the same requirement of a signed contract or a recorded reason, as any
 * other lease.
 */
export async function renewLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const typedStart = String(formData.get('newStartDate') ?? '').trim();
    const newStartDate = parseDayMonthYear(typedStart);
    if (!newStartDate) throw invalid('Enter the new start date as dd/mm/yyyy.');

    const typedEnd = String(formData.get('newEndDate') ?? '').trim();
    const newEndDate = typedEnd ? parseDayMonthYear(typedEnd) : null;
    if (typedEnd && !newEndDate) throw invalid('Enter the new end date as dd/mm/yyyy.');

    const rent = String(formData.get('newRent') ?? '').trim();
    if (!rent) throw invalid('Say what the rent is for the new term.');

    const renewal = await renewLease(tx, context.organisationId, viewer.authUserId, {
      leaseId,
      newStartDate,
      ...(newEndDate ? { newEndDate } : {}),
      newRentMinor: parseMajorToMinor(rent, context.currencyCode),
    });
    return renewal;
  });
  if (result.ok) {
    revalidatePath(`/app/${org}/leases/${leaseId}`);
    revalidatePath(`/app/${org}/leases`);
  }
  return result;
}

export async function terminateLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const typedDate = String(formData.get('effectiveDate') ?? '').trim();
    const effectiveDate = parseDayMonthYear(typedDate);
    if (!effectiveDate) throw invalid('Enter the end date as dd/mm/yyyy.');
    const reason = String(formData.get('reason') ?? '');

    const outcome = await terminateLease(tx, context.organisationId, viewer.authUserId, {
      leaseId, reason, effectiveDate,
    });

    // The resident is told, because a lease ending is the sort of thing they
    // should hear from the system rather than discover. Both the notice and the
    // email carry the reason: a date with no explanation invites a phone call.
    //
    // This is the one notice that emails a resident who asked not to be
    // emailed. A lease ending changes where they live and what they owe, and a
    // preference set months earlier is not consent to miss it. The override is
    // counted and shown to the operator, never applied quietly.
    const delivery = await notifyLeaseResidents(tx, context.organisationId, {
      leaseId,
      templateKey: 'lease.terminated',
      title: 'Your lease has been ended',
      body: `Your lease ends on ${typedDate}. Reason given: ${reason}`
        + ' Any balance still owing remains payable.',
      linkPath: `/portal/${leaseId}`,
      email: {
        overridePreference: true,
        subject: 'Your lease has been ended',
        body: [
          `Your lease ends on ${typedDate}.`,
          '',
          `Reason given: ${reason}`,
          '',
          'Ending the lease does not clear what is owed. Any balance on your account '
            + 'remains payable, and your deposit is handled separately.',
          '',
          'Sign in to PropertyOS to see your statement and documents.',
        ].join('\n'),
      },
    });
    return { ...outcome, ...delivery };
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}

export async function extendLeaseAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const leaseId = String(formData.get('leaseId'));

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const typedDate = String(formData.get('newEndDate') ?? '').trim();
    const newEndDate = parseDayMonthYear(typedDate);
    if (!newEndDate) throw invalid('Enter the new end date as dd/mm/yyyy.');
    const reason = String(formData.get('reason') ?? '');

    const outcome = await extendLease(tx, context.organisationId, viewer.authUserId, {
      leaseId, newEndDate, reason,
    });

    const delivery = await notifyLeaseResidents(tx, context.organisationId, {
      leaseId,
      templateKey: 'lease.extended',
      title: 'Your lease has been extended',
      body: `Your lease now runs to ${typedDate}. Reason given: ${reason}`,
      linkPath: `/portal/${leaseId}`,
      email: {
        subject: 'Your lease has been extended',
        body: [
          `Your lease now runs to ${typedDate}.`,
          '',
          `Reason given: ${reason}`,
          '',
          'Nothing else about the lease has changed. Sign in to PropertyOS to see your '
            + 'statement and documents.',
        ].join('\n'),
      },
    });
    return { ...outcome, ...delivery };
  });
  if (result.ok) revalidatePath(`/app/${org}/leases/${leaseId}`);
  return result;
}
