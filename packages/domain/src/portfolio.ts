import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, notFound, parsed } from './errors';
import { requireEntitlement } from './entitlements';
import { requirePermission, requirePropertyScope } from './permissions';

export const createPropertySchema = z.object({
  portfolioId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/, 'Use letters, numbers, dot, dash or underscore.'),
  propertyType: z.enum(['house', 'cottage', 'apartment', 'apartment_block', 'townhouse', 'other']),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).optional().or(z.literal('')),
  suburb: z.string().trim().max(120).optional().or(z.literal('')),
  city: z.string().trim().min(1).max(120),
  province: z.string().trim().max(120).optional().or(z.literal('')),
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  countryCode: z.string().length(2).toUpperCase().default('ZA'),
  purchasePriceMinor: z.bigint().nonnegative().optional(),
  purchaseDate: z.string().date().optional(),
});

export const createUnitSchema = z.object({
  propertyId: z.string().uuid(),
  buildingId: z.string().uuid().optional(),
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,23}$/),
  description: z.string().trim().max(300).optional().or(z.literal('')),
  rentableType: z.enum(['whole_property', 'apartment', 'cottage', 'room', 'other']).default('apartment'),
  bedrooms: z.number().int().min(0).max(50).optional(),
  bathrooms: z.number().min(0).max(50).optional(),
  floor: z.string().trim().max(40).optional().or(z.literal('')),
  floorAreaSqm: z.number().positive().optional(),
  advertisedRentMinor: z.bigint().nonnegative().optional(),
});

const blankToNull = (v: string | undefined) => (v === undefined || v === '' ? null : v);

export async function createProperty(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof createPropertySchema>,
): Promise<{ propertyId: string }> {
  await requirePermission(tx, organisationId, 'property.create');
  const p = createPropertySchema.parse(input);

  let portfolioId = p.portfolioId;
  if (!portfolioId) {
    const [def] = await tx<{ id: string }[]>`
      select id from portfolios where organisation_id = ${organisationId}::uuid order by created_at limit 1
    `;
    if (!def) throw notFound('Portfolio');
    portfolioId = def.id;
  } else {
    // The portfolio must belong to this organisation. The composite foreign key
    // enforces this too; checking here produces a readable error.
    const [owned] = await tx<{ id: string }[]>`
      select id from portfolios
      where id = ${portfolioId}::uuid and organisation_id = ${organisationId}::uuid
    `;
    if (!owned) throw notFound('Portfolio');
  }

  try {
    const [row] = await tx<{ id: string }[]>`
      insert into properties (
        organisation_id, portfolio_id, name, code, property_type,
        address_line1, address_line2, suburb, city, province, postal_code, country_code,
        purchase_price_minor, purchase_date
      ) values (
        ${organisationId}, ${portfolioId}, ${p.name}, ${p.code}, ${p.propertyType},
        ${p.addressLine1}, ${blankToNull(p.addressLine2)}, ${blankToNull(p.suburb)},
        ${p.city}, ${blankToNull(p.province)}, ${blankToNull(p.postalCode)}, ${p.countryCode},
        ${p.purchasePriceMinor?.toString() ?? null}, ${p.purchaseDate ?? null}
      )
      returning id
    `;
    if (!row) throw new DomainError('internal', 'Property insert returned no row.');
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'property.created', resourceType: 'property', resourceId: row.id,
      after: { name: p.name, code: p.code, type: p.propertyType },
    });
    return { propertyId: row.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw fromDatabaseError(error);
  }
}

export async function createUnit(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof createUnitSchema>,
): Promise<{ unitId: string }> {
  const u = createUnitSchema.parse(input);
  await requirePermission(tx, organisationId, 'property.update');
  await requirePropertyScope(tx, organisationId, u.propertyId);
  // The plan's unit allowance, enforced at the one place a unit comes into
  // existence. `requireEntitlement` was written, tested and called from
  // nowhere, which made every plan in the price list unlimited: a customer on
  // the ten-unit plan could add five hundred. Checked after the permission so
  // somebody who may not do this at all is told that, not told to upgrade.
  await requireEntitlement(tx, organisationId, 'billable_units');

  try {
    const [row] = await tx<{ id: string }[]>`
      insert into units (
        organisation_id, property_id, building_id, code, description, rentable_type,
        bedrooms, bathrooms, floor, floor_area_sqm, advertised_rent_minor
      ) values (
        ${organisationId}, ${u.propertyId}, ${u.buildingId ?? null}, ${u.code},
        ${blankToNull(u.description)}, ${u.rentableType},
        ${u.bedrooms ?? null}, ${u.bathrooms ?? null}, ${blankToNull(u.floor)},
        ${u.floorAreaSqm ?? null}, ${u.advertisedRentMinor?.toString() ?? null}
      )
      returning id
    `;
    if (!row) throw new DomainError('internal', 'Unit insert returned no row.');
    await recordAudit(tx, {
      organisationId, actorUserId,
      action: 'unit.created', resourceType: 'unit', resourceId: row.id,
      after: { propertyId: u.propertyId, code: u.code },
    });
    return { unitId: row.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const mapped = fromDatabaseError(error);
    if (mapped.code === 'duplicate') {
      throw new DomainError('duplicate', `Unit code "${u.code}" already exists in this property.`);
    }
    throw mapped;
  }
}

/** Creates a house: one property with a single whole-property unit. */
export async function createStandaloneHouse(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: z.input<typeof createPropertySchema>,
): Promise<{ propertyId: string; unitId: string }> {
  const { propertyId } = await createProperty(tx, organisationId, actorUserId, input);
  const { unitId } = await createUnit(tx, organisationId, actorUserId, {
    propertyId,
    code: 'MAIN',
    rentableType: 'whole_property',
    description: 'Whole property',
  });
  return { propertyId, unitId };
}

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */
//
// A property or unit could be created and never corrected. A typo in a unit
// code, a street name spelled wrong, a block that gained a flat — all of it
// needed somebody with database access, which in practice means it stays wrong.
//
// What editing must not do is rewrite history. A lease agreement records the
// address it was generated with, and a charge records the lease it was raised
// against, so correcting a property's address today does not restate a document
// somebody signed last year. That is a property of how those records are
// stored, not of this code being careful, and it is why editing here is safe.

export const updatePropertySchema = createPropertySchema
  .omit({ portfolioId: true })
  .partial()
  .extend({ reason: z.string().trim().max(500).optional() });

export const updateUnitSchema = createUnitSchema
  .omit({ propertyId: true, buildingId: true })
  .partial();

/** The fields of a property, for a form that has to show what is there now. */
export interface PropertyDetails {
  id: string;
  name: string;
  code: string;
  propertyType: string;
  addressLine1: string;
  addressLine2: string | null;
  suburb: string | null;
  city: string;
  province: string | null;
  postalCode: string | null;
  countryCode: string;
  purchasePriceMinor: bigint | null;
  purchaseDate: string | null;
  status: 'active' | 'archived';
  unitCount: number;
  activeUnitCount: number;
  /** Units with a lease that has not ended. Nothing may be retired under one. */
  occupiedUnitCount: number;
}

export async function getPropertyDetails(
  tx: Sql, organisationId: string, propertyId: string,
): Promise<PropertyDetails | undefined> {
  const [row] = await tx<
    { id: string; name: string; code: string; property_type: string; address_line1: string;
      address_line2: string | null; suburb: string | null; city: string;
      province: string | null; postal_code: string | null; country_code: string;
      purchase_price_minor: string | null; purchase_date: string | null; status: string;
      unit_count: string; active_unit_count: string; occupied_unit_count: string }[]
  >`
    select p.id, p.name, p.code, p.property_type::text, p.address_line1, p.address_line2,
           p.suburb, p.city, p.province, p.postal_code, p.country_code,
           p.purchase_price_minor::text, p.purchase_date::text, p.status::text,
           (select count(*) from units u where u.property_id = p.id)::text as unit_count,
           (select count(*) from units u
             where u.property_id = p.id and u.status = 'active')::text as active_unit_count,
           (select count(distinct u.id) from units u
              join leases l on l.unit_id = u.id
             where u.property_id = p.id
               and l.status in ('draft', 'awaiting_execution', 'active', 'notice_given')
           )::text as occupied_unit_count
      from properties p
     where p.id = ${propertyId}::uuid and p.organisation_id = ${organisationId}::uuid
  `;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    propertyType: row.property_type,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    suburb: row.suburb,
    city: row.city,
    province: row.province,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    purchasePriceMinor: row.purchase_price_minor === null
      ? null : BigInt(row.purchase_price_minor),
    purchaseDate: row.purchase_date,
    status: row.status as 'active' | 'archived',
    unitCount: Number(row.unit_count),
    activeUnitCount: Number(row.active_unit_count),
    occupiedUnitCount: Number(row.occupied_unit_count),
  };
}

/**
 * Corrects a property's details.
 *
 * Only the fields supplied are changed, and the audit entry carries the before
 * and after of each one — a correction nobody can see afterwards is
 * indistinguishable from a quiet rewrite.
 */
export async function updateProperty(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  propertyId: string,
  input: z.input<typeof updatePropertySchema>,
): Promise<void> {
  await requirePermission(tx, organisationId, 'property.update');
  await requirePropertyScope(tx, organisationId, propertyId);
  const p = parsed(updatePropertySchema, input);

  const before = await getPropertyDetails(tx, organisationId, propertyId);
  if (!before) throw notFound('Property');

  // Only fields the caller actually supplied are considered, keyed off the raw
  // input rather than the parsed object. The schema injects a default country
  // code, and an omitted optional field parses to `undefined` — reading either
  // as "set this to nothing" would have the audit entry claim a field was
  // blanked while the SQL below correctly leaves the column alone. An audit
  // trail that misreports the change is worse than none.
  const supplied = (field: string) => Object.hasOwn(input as object, field);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const record = (field: string, from: unknown, to: unknown) => {
    if (!supplied(field)) return;
    if (to !== from) changes[field] = { from, to };
  };
  record('name', before.name, p.name);
  record('code', before.code, p.code);
  record('propertyType', before.propertyType, p.propertyType);
  record('addressLine1', before.addressLine1, p.addressLine1);
  record('addressLine2', before.addressLine2, blankToNull(p.addressLine2));
  record('suburb', before.suburb, blankToNull(p.suburb));
  record('city', before.city, p.city);
  record('province', before.province, blankToNull(p.province));
  record('postalCode', before.postalCode, blankToNull(p.postalCode));

  if (Object.keys(changes).length === 0) return;

  try {
    await tx`
      update properties set
        name = coalesce(${p.name ?? null}, name),
        code = coalesce(${p.code ?? null}, code),
        property_type = coalesce(${p.propertyType ?? null}::app.property_type, property_type),
        address_line1 = coalesce(${p.addressLine1 ?? null}, address_line1),
        address_line2 = ${supplied('addressLine2')
          ? blankToNull(p.addressLine2) : tx`address_line2`},
        suburb = ${supplied('suburb') ? blankToNull(p.suburb) : tx`suburb`},
        city = coalesce(${p.city ?? null}, city),
        province = ${supplied('province') ? blankToNull(p.province) : tx`province`},
        postal_code = ${supplied('postalCode')
          ? blankToNull(p.postalCode) : tx`postal_code`},
        updated_at = now()
      where id = ${propertyId}::uuid and organisation_id = ${organisationId}::uuid
    `;
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.code === 'duplicate') {
      throw new DomainError(
        'duplicate',
        `Another property already uses the code "${p.code}". Codes appear on documents, so `
          + 'two properties cannot share one.',
      );
    }
    throw mapped;
  }

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'property.updated', resourceType: 'property', resourceId: propertyId,
    reason: p.reason,
    before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
    after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
  });
}

/** Corrects a unit's details. The advertised rent is marketing, never the rent. */
export async function updateUnit(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  unitId: string,
  input: z.input<typeof updateUnitSchema>,
): Promise<void> {
  await requirePermission(tx, organisationId, 'property.update');
  const u = parsed(updateUnitSchema, input);
  const supplied = (field: string) => Object.hasOwn(input as object, field);

  const [before] = await tx<
    { id: string; property_id: string; code: string; description: string | null;
      rentable_type: string; bedrooms: number | null; bathrooms: string | null;
      floor: string | null; floor_area_sqm: string | null;
      advertised_rent_minor: string | null; status: string }[]
  >`
    select id, property_id, code, description, rentable_type::text, bedrooms,
           bathrooms::text, floor, floor_area_sqm::text, advertised_rent_minor::text,
           status::text
      from units
     where id = ${unitId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!before) throw notFound('Unit');
  await requirePropertyScope(tx, organisationId, before.property_id);

  try {
    await tx`
      update units set
        code = coalesce(${u.code ?? null}, code),
        description = ${supplied('description')
          ? blankToNull(u.description) : tx`description`},
        rentable_type = coalesce(${u.rentableType ?? null}::app.unit_rentable_type,
                                 rentable_type),
        bedrooms = ${supplied('bedrooms') ? u.bedrooms ?? null : tx`bedrooms`},
        bathrooms = ${supplied('bathrooms') ? u.bathrooms ?? null : tx`bathrooms`},
        floor = ${supplied('floor') ? blankToNull(u.floor) : tx`floor`},
        floor_area_sqm = ${supplied('floorAreaSqm')
          ? u.floorAreaSqm ?? null : tx`floor_area_sqm`},
        -- The ADVERTISED rent. A lease's contracted rent lives on the lease and
        -- is changed by a renewal, never from here.
        advertised_rent_minor = ${supplied('advertisedRentMinor')
          ? u.advertisedRentMinor?.toString() ?? null : tx`advertised_rent_minor`},
        updated_at = now()
      where id = ${unitId}::uuid and organisation_id = ${organisationId}::uuid
    `;
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.code === 'duplicate') {
      throw new DomainError(
        'duplicate', `Unit code "${u.code}" already exists in this property.`,
      );
    }
    throw mapped;
  }

  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'unit.updated', resourceType: 'unit', resourceId: unitId,
    before: {
      code: before.code, rentableType: before.rentable_type,
      advertisedRentMinor: before.advertised_rent_minor,
    },
    after: {
      code: u.code ?? before.code,
      rentableType: u.rentableType ?? before.rentable_type,
      advertisedRentMinor: supplied('advertisedRentMinor')
        ? u.advertisedRentMinor?.toString() ?? null : before.advertised_rent_minor,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Retiring                                                                   */
/* -------------------------------------------------------------------------- */

/** Lease statuses that mean somebody's arrangement still depends on the unit. */
const LIVE_LEASE_STATUSES = ['draft', 'awaiting_execution', 'active', 'notice_given'] as const;

/**
 * Retires a unit.
 *
 * Refused while any lease on it is still live — including a draft, which is
 * somebody's half-finished work and would be orphaned without a word. "Do not
 * silently retire occupied units" is the rule; this does not retire them
 * loudly either, it refuses and says which lease is in the way.
 *
 * Retiring is not deletion. The unit, its leases, its charges and its
 * inspections all stay exactly where they are; the unit simply stops being
 * offered for new leases. Nothing in the ledger moves.
 */
export async function retireUnit(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { unitId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'property.update');
  const reason = parsed(
    z.string().trim().min(5, 'Say why the unit is being retired. The next reader needs it.')
      .max(500),
    input.reason,
  );

  const [unit] = await tx<{ id: string; property_id: string; code: string; status: string }[]>`
    select id, property_id, code, status::text from units
     where id = ${input.unitId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!unit) throw notFound('Unit');
  await requirePropertyScope(tx, organisationId, unit.property_id);
  if (unit.status === 'archived') {
    throw new DomainError('conflict', `Unit ${unit.code} is already retired.`);
  }

  const live = await tx<{ reference: string; status: string }[]>`
    select reference, status::text from leases
     where unit_id = ${input.unitId}::uuid
       and organisation_id = ${organisationId}::uuid
       and status = any(${LIVE_LEASE_STATUSES as unknown as string[]}::app.lease_status[])
     order by start_date
  `;
  if (live.length > 0) {
    const named = live.map((l) => `${l.reference} (${l.status.replace(/_/g, ' ')})`).join(', ');
    throw new DomainError(
      'conflict',
      `Unit ${unit.code} cannot be retired while ${live.length === 1 ? 'a lease is' : 'leases are'} `
        + `still live on it: ${named}. End or cancel ${live.length === 1 ? 'it' : 'them'} first — `
        + 'retiring a unit somebody is living in, or that somebody is still drafting a lease '
        + 'for, would hide the arrangement rather than end it.',
    );
  }

  await tx`
    update units set status = 'archived', updated_at = now()
     where id = ${input.unitId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'unit.retired', resourceType: 'unit', resourceId: input.unitId, reason,
    before: { status: 'active' },
    // Said plainly, because "retired" reads like "removed" and is not.
    after: { status: 'archived', code: unit.code, ledgerEffect: 'none' },
  });
}

/** Puts a retired unit back into use. */
export async function reinstateUnit(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { unitId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'property.update');
  const reason = parsed(z.string().trim().min(5).max(500), input.reason);

  const [unit] = await tx<{ id: string; property_id: string; code: string; status: string }[]>`
    select id, property_id, code, status::text from units
     where id = ${input.unitId}::uuid and organisation_id = ${organisationId}::uuid
     for update
  `;
  if (!unit) throw notFound('Unit');
  await requirePropertyScope(tx, organisationId, unit.property_id);
  if (unit.status !== 'archived') {
    throw new DomainError('conflict', `Unit ${unit.code} is not retired.`);
  }

  const [property] = await tx<{ status: string }[]>`
    select status::text from properties
     where id = ${unit.property_id}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (property?.status === 'archived') {
    throw new DomainError(
      'conflict',
      'The property itself is archived. Reinstate the property first, otherwise the unit would '
        + 'be the only live thing inside something nobody is managing.',
    );
  }

  await tx`
    update units set status = 'active', updated_at = now()
     where id = ${input.unitId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'unit.reinstated', resourceType: 'unit', resourceId: input.unitId, reason,
    before: { status: 'archived' }, after: { status: 'active', code: unit.code },
  });
}

/**
 * Archives a property.
 *
 * Refused while any unit in it is still active, which in turn refuses while
 * any of those units is occupied. Archiving the property first would retire
 * every unit under it in one move, which is exactly the silent retirement the
 * brief rules out.
 */
export async function archiveProperty(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { propertyId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'property.update');
  await requirePropertyScope(tx, organisationId, input.propertyId);
  const reason = parsed(
    z.string().trim().min(5, 'Say why the property is being archived.').max(500),
    input.reason,
  );

  const property = await getPropertyDetails(tx, organisationId, input.propertyId);
  if (!property) throw notFound('Property');
  if (property.status === 'archived') {
    throw new DomainError('conflict', `${property.name} is already archived.`);
  }
  if (property.activeUnitCount > 0) {
    throw new DomainError(
      'conflict',
      `${property.name} still has ${property.activeUnitCount} `
        + `active unit${property.activeUnitCount === 1 ? '' : 's'}`
        + `${property.occupiedUnitCount > 0
          ? `, ${property.occupiedUnitCount} of them with a live lease` : ''}`
        + '. Retire each unit first: archiving the property would retire them all in one move '
        + 'without anybody seeing which were still let.',
    );
  }

  await tx`
    update properties set status = 'archived', updated_at = now()
     where id = ${input.propertyId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'property.archived', resourceType: 'property', resourceId: input.propertyId, reason,
    before: { status: 'active' },
    after: { status: 'archived', name: property.name, ledgerEffect: 'none' },
  });
}

/** Puts an archived property back into use. Its units stay retired. */
export async function reinstateProperty(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  input: { propertyId: string; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'property.update');
  await requirePropertyScope(tx, organisationId, input.propertyId);
  const reason = parsed(z.string().trim().min(5).max(500), input.reason);

  const property = await getPropertyDetails(tx, organisationId, input.propertyId);
  if (!property) throw notFound('Property');
  if (property.status !== 'archived') {
    throw new DomainError('conflict', `${property.name} is not archived.`);
  }

  await tx`
    update properties set status = 'active', updated_at = now()
     where id = ${input.propertyId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'property.reinstated', resourceType: 'property', resourceId: input.propertyId, reason,
    before: { status: 'archived' },
    // Reinstating the property does not reinstate its units: each was retired
    // for its own reason, and undoing those in bulk would be the same mistake
    // in the other direction.
    after: { status: 'active', unitsReinstated: 0 },
  });
}
