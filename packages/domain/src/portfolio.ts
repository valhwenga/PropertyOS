import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, fromDatabaseError, notFound } from './errors';
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
