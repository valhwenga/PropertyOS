import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, fromDatabaseError, invalid, notFound } from './errors';
import { requirePermission, requirePropertyScope } from './permissions';

export const inspectionItemSchema = z.object({
  room: z.string().trim().min(1).max(80),
  item: z.string().trim().min(1).max(120),
  condition: z.enum(['good', 'fair', 'poor', 'damaged', 'not_applicable']),
  // Fair wear and tear is recorded distinctly from damage. Conflating them is
  // how a deposit deduction becomes indefensible.
  damageType: z.enum(['fair_wear_and_tear', 'damage', 'missing']).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  items: z.array(z.object({
    room: z.string().trim().min(1),
    item: z.string().trim().min(1),
  })).min(1),
});

/**
 * Creates a NEW VERSION of a checklist template.
 *
 * Templates are versioned rather than edited, because an inspection records the
 * template version it was performed against. Changing a checklist must never
 * retroactively alter what an inspector actually checked.
 */
export async function createTemplateVersion(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof createTemplateSchema>,
): Promise<{ templateId: string; version: number }> {
  await requirePermission(tx, organisationId, 'inspection.manage');
  const t = createTemplateSchema.parse(input);

  const [existing] = await tx<{ version: number }[]>`
    select coalesce(max(version), 0) as version from inspection_templates
    where organisation_id = ${organisationId}::uuid and name = ${t.name}
  `;
  const version = (existing?.version ?? 0) + 1;

  // Supersede the previous version rather than deleting it.
  await tx`
    update inspection_templates set is_active = false
    where organisation_id = ${organisationId}::uuid and name = ${t.name}
  `;

  const [template] = await tx<{ id: string }[]>`
    insert into inspection_templates (organisation_id, name, version, items, is_active)
    values (${organisationId}, ${t.name}, ${version}, ${tx.json(t.items as never)}, true)
    returning id
  `;
  if (!template) throw new DomainError('internal', 'Template insert returned no row.');

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'inspection.template.versioned', resourceType: 'inspection_template',
    resourceId: template.id, after: { name: t.name, version, itemCount: t.items.length },
  });
  return { templateId: template.id, version };
}

export async function createInspection(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    unitId: string;
    leaseId?: string;
    templateId: string;
    inspectionType: 'move_in' | 'move_out' | 'routine' | 'other';
    scheduledFor?: string;
  },
): Promise<{ inspectionId: string }> {
  await requirePermission(tx, organisationId, 'inspection.manage');

  const [unit] = await tx<{ property_id: string }[]>`
    select property_id from units
    where id = ${params.unitId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!unit) throw notFound('Unit');
  await requirePropertyScope(tx, organisationId, unit.property_id);

  const [template] = await tx<{ id: string; version: number; items: unknown }[]>`
    select id, version, items from inspection_templates
    where id = ${params.templateId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!template) throw notFound('Inspection template');

  const [inspection] = await tx<{ id: string }[]>`
    insert into inspections (
      organisation_id, property_id, unit_id, lease_id, template_id, template_version,
      inspection_type, scheduled_for, inspector_user_id, status
    ) values (
      ${organisationId}, ${unit.property_id}, ${params.unitId}, ${params.leaseId ?? null},
      ${template.id}, ${template.version}, ${params.inspectionType},
      ${params.scheduledFor ?? null}, ${actorUserId}, 'draft'
    )
    returning id
  `;
  if (!inspection) throw new DomainError('internal', 'Inspection insert returned no row.');

  // Pre-populate from the template so the inspector works through a fixed list.
  const items = template.items as Array<{ room: string; item: string }>;
  await tx`
    insert into inspection_items ${tx(
      items.map((i, index) => ({
        organisation_id: organisationId,
        inspection_id: inspection.id,
        room: i.room,
        item: i.item,
        condition: 'not_applicable',
        sort_order: index,
      })),
    )}
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'inspection.created', resourceType: 'inspection', resourceId: inspection.id,
    after: { type: params.inspectionType, templateVersion: template.version },
  });
  return { inspectionId: inspection.id };
}

/**
 * Finalises an inspection.
 *
 * Once finalised the record is closed to edits. A correction requires a new
 * VERSION with a stated reason, which supersedes this one; the original stays
 * readable so a later dispute can see exactly what was submitted and when.
 */
export async function finaliseInspection(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { inspectionId: string; performedOn: string; attendees?: string; keysHandedOver?: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'inspection.manage');

  const [inspection] = await tx<{ id: string; status: string; property_id: string }[]>`
    select id, status, property_id from inspections
    where id = ${params.inspectionId}::uuid and organisation_id = ${organisationId}::uuid
    for update
  `;
  if (!inspection) throw notFound('Inspection');
  await requirePropertyScope(tx, organisationId, inspection.property_id);
  if (inspection.status !== 'draft') {
    throw new DomainError(
      'conflict',
      `This inspection is "${inspection.status}" and cannot be finalised again. ` +
        'Create a new version with a reason instead.',
    );
  }

  await tx`
    update inspections set
      status = 'finalised', finalised_at = now(), performed_on = ${params.performedOn},
      attendees = ${params.attendees ?? null}, keys_handed_over = ${params.keysHandedOver ?? null}
    where id = ${params.inspectionId}::uuid
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'inspection.finalised', resourceType: 'inspection', resourceId: params.inspectionId,
    after: { performedOn: params.performedOn },
  });
  await emitEvent(tx, {
    organisationId, eventType: 'inspection.finalised',
    resourceType: 'inspection', resourceId: params.inspectionId,
    payload: { performedOn: params.performedOn },
  });
}

/** Creates a corrected version, superseding the original without erasing it. */
export async function reviseInspection(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { inspectionId: string; reason: string },
): Promise<{ inspectionId: string }> {
  await requirePermission(tx, organisationId, 'inspection.manage');
  if (params.reason.trim().length < 5) throw invalid('A revision requires a reason.');

  const [original] = await tx<
    { id: string; property_id: string; unit_id: string; lease_id: string | null;
      template_id: string; template_version: number; inspection_type: string }[]
  >`
    select id, property_id, unit_id, lease_id, template_id, template_version, inspection_type
    from inspections
    where id = ${params.inspectionId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!original) throw notFound('Inspection');

  const [revision] = await tx<{ id: string }[]>`
    insert into inspections (
      organisation_id, property_id, unit_id, lease_id, template_id, template_version,
      inspection_type, inspector_user_id, status, supersedes_inspection_id, revision_reason
    ) values (
      ${organisationId}, ${original.property_id}, ${original.unit_id}, ${original.lease_id},
      ${original.template_id}, ${original.template_version}, ${original.inspection_type},
      ${actorUserId}, 'draft', ${original.id}, ${params.reason}
    )
    returning id
  `;
  if (!revision) throw new DomainError('internal', 'Revision insert returned no row.');

  // Carry the recorded conditions forward as the starting point.
  await tx`
    insert into inspection_items (organisation_id, inspection_id, room, item, condition, damage_type, note, sort_order)
    select organisation_id, ${revision.id}, room, item, condition, damage_type, note, sort_order
    from inspection_items where inspection_id = ${original.id}::uuid
  `;
  await tx`
    update inspections set status = 'superseded' where id = ${original.id}::uuid
  `;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'inspection.revised', resourceType: 'inspection', resourceId: revision.id,
    reason: params.reason, after: { supersedes: original.id },
  });
  return { inspectionId: revision.id };
}

/**
 * Records a resident's acknowledgement or dispute.
 *
 * The resident can never edit the inspector's record. Their response is a
 * separate row, and a dispute is preserved rather than resolved by overwriting.
 */
export async function respondToInspection(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: {
    inspectionId: string; residentId: string;
    response: 'acknowledged' | 'disputed'; comment?: string;
  },
): Promise<void> {
  if (params.response === 'disputed' && !params.comment?.trim()) {
    throw invalid('Please describe what you disagree with.');
  }

  const [inspection] = await tx<{ id: string; status: string; lease_id: string | null }[]>`
    select id, status, lease_id from inspections
    where id = ${params.inspectionId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!inspection) throw notFound('Inspection');
  if (!['finalised', 'acknowledged', 'disputed'].includes(inspection.status)) {
    throw new DomainError('conflict', 'This inspection is not yet finalised.');
  }

  try {
    await tx`
      insert into inspection_acknowledgements (
        organisation_id, inspection_id, resident_id, response, comment, responded_by
      ) values (
        ${organisationId}, ${params.inspectionId}, ${params.residentId},
        ${params.response}, ${params.comment ?? null}, ${actorUserId}
      )
      on conflict (inspection_id, resident_id) do update
        set response = excluded.response, comment = excluded.comment, responded_at = now()
    `;
  } catch (error) {
    throw fromDatabaseError(error);
  }

  // A dispute must be visible on the inspection itself, not buried in a child
  // row. Residents deliberately have no write access to `inspections` — that
  // would let them touch an inspector's record — so the status is RE-DERIVED
  // from the acknowledgement rows by a narrow function that takes no
  // caller-supplied status of its own.
  await tx`select app.sync_inspection_response_status(${params.inspectionId}::uuid)`;

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: `inspection.${params.response}`, resourceType: 'inspection',
    resourceId: params.inspectionId, after: { response: params.response },
  });
}
