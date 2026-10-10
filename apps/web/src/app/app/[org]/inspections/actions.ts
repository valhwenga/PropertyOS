'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createInspection, createTemplateVersion, finaliseInspection,
  recordInspectionFindings, reviseInspection,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Inspection commands.
 *
 * The versioning rules are the domain's: a finalised inspection is closed to
 * edits and corrected by superseding it, and a template is versioned rather
 * than edited so an inspection always records the checklist it was actually
 * performed against.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function createInspectionAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return createInspection(tx, context.organisationId, viewer.authUserId, {
      unitId: str(formData, 'unitId'),
      leaseId: str(formData, 'leaseId') || undefined,
      templateId: str(formData, 'templateId'),
      inspectionType: str(formData, 'inspectionType') as
        'move_in' | 'move_out' | 'routine' | 'other',
      scheduledFor: str(formData, 'scheduledFor') || undefined,
    });
  });
  if (result.ok) {
    revalidatePath(`/app/${org}/inspections`);
    redirect(`/app/${org}/inspections/${result.inspectionId}`);
  }
  return result;
}

/**
 * Records the findings.
 *
 * Every item is submitted, not only the changed ones: the form shows the whole
 * checklist and what comes back is what the inspector left on screen. An item
 * they deliberately set back to unanswered has to be able to go back.
 */
export async function recordFindingsAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const inspectionId = str(formData, 'inspectionId');

  const findings: Array<{
    itemId: string;
    condition: 'good' | 'fair' | 'poor' | 'damaged' | 'not_applicable';
    damageType?: 'fair_wear_and_tear' | 'damage' | 'missing';
    note?: string;
  }> = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('condition:')) continue;
    const itemId = key.slice('condition:'.length);
    const damage = str(formData, `damage:${itemId}`);
    const note = str(formData, `note:${itemId}`);
    findings.push({
      itemId,
      condition: String(value) as 'good' | 'fair' | 'poor' | 'damaged' | 'not_applicable',
      damageType: damage
        ? (damage as 'fair_wear_and_tear' | 'damage' | 'missing')
        : undefined,
      note: note || undefined,
    });
  }

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return recordInspectionFindings(tx, context.organisationId, viewer.authUserId, {
      inspectionId, findings,
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/inspections/${inspectionId}`);
  return result;
}

export async function finaliseInspectionAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const inspectionId = str(formData, 'inspectionId');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await finaliseInspection(tx, context.organisationId, viewer.authUserId, {
      inspectionId,
      performedOn: str(formData, 'performedOn'),
      attendees: str(formData, 'attendees') || undefined,
      keysHandedOver: str(formData, 'keysHandedOver') || undefined,
    });
    return { finalised: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/inspections/${inspectionId}`);
  return result;
}

export async function reviseInspectionAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return reviseInspection(tx, context.organisationId, viewer.authUserId, {
      inspectionId: str(formData, 'inspectionId'),
      reason: str(formData, 'reason'),
    });
  });
  if (result.ok) {
    revalidatePath(`/app/${org}/inspections`);
    redirect(`/app/${org}/inspections/${result.inspectionId}`);
  }
  return result;
}

/**
 * Publishes a new version of a checklist.
 *
 * Never an edit. An inspection records the version it was performed against,
 * and changing a checklist must not retroactively alter what was checked.
 */
export async function createTemplateVersionAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const lines = str(formData, 'items')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [room, ...rest] = l.split(':');
      return { room: (room ?? '').trim(), item: rest.join(':').trim() };
    })
    .filter((i) => i.room && i.item);

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return createTemplateVersion(tx, context.organisationId, viewer.authUserId, {
      name: str(formData, 'name'),
      items: lines,
    });
  });
  if (result.ok) revalidatePath(`/app/${org}/inspections`);
  return result;
}
