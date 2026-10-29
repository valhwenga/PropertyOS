import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { chargeCategoryByKey } from './charge-categories';
import { recordAudit } from './audit';
import { invalid, notFound } from './errors';
import type { Minor } from './money';
import { requirePermission } from './permissions';

/**
 * The month's charges, typed before anything is billed.
 *
 * A landlord bills water, refuse and sewerage every month, and the product
 * made them do it one lease at a time: open the lease, open the charges panel,
 * type the readings, post. Forty tenancies is forty visits — and each posting
 * produced its own invoice, so a tenant with water and refuse received three
 * documents in a month, none of which could be corrected afterwards because a
 * posted charge document is immutable by trigger.
 *
 * That immutability is right. What was wrong is where the typing happened.
 * Here it happens BEFORE posting: one pass over every active lease, into rows
 * that can be edited, checked and deleted until somebody approves the run.
 *
 * A captured charge is a draft. It is not in the ledger, it is not a document,
 * nobody has been billed, and the invoice only exists once the billing run
 * posts it — which is also where the arithmetic gets checked for the last
 * time, against live data rather than against what the screen said an hour
 * ago.
 */

const captureSchema = z.object({
  leaseId: z.string().uuid(),
  category: z.string().min(1),
  description: z.string().trim().max(200).optional(),
  /** Minor units. Given directly, or computed from quantity × rate below. */
  amountMinor: z.coerce.bigint().positive().optional(),
  quantity: z.coerce.number().nonnegative().optional(),
  unitRateMinor: z.coerce.bigint().nonnegative().optional(),
  unit: z.string().trim().max(12).optional(),
  meterPrevious: z.coerce.number().nonnegative().optional(),
  meterCurrent: z.coerce.number().nonnegative().optional(),
  note: z.string().trim().max(500).optional(),
});

export type CaptureInput = z.input<typeof captureSchema>;

export interface PendingCharge {
  id: string;
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  propertyName: string;
  periodStart: string;
  category: string;
  categoryLabel: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitRateMinor: number | null;
  meterPrevious: number | null;
  meterCurrent: number | null;
  amountMinor: number;
  currencyCode: string;
  note: string | null;
  capturedByName: string | null;
  updatedAt: string;
  postedAt: string | null;
  chargeDocumentId: string | null;
}

function monthStart(period: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) throw invalid('A billing month looks like 2026-03-01.');
  if (!period.endsWith('-01')) throw invalid('A billing month starts on the first of the month.');
  return period;
}

/**
 * Works out the amount, and refuses to guess.
 *
 * Three ways a landlord has the figure: the municipal account says R1,119.30;
 * or the meter moved 41 units at a tariff; or they have the consumption and
 * the tariff without the readings. Any of them is fine. What is not fine is
 * two of them disagreeing — a typed amount that is not quantity × rate is
 * somebody's arithmetic slipping, and the invoice would show lines that do not
 * add up to their own total.
 */
function resolveAmount(input: z.infer<typeof captureSchema>): {
  amountMinor: bigint; quantity: number | null;
} {
  const measured = input.meterPrevious !== undefined && input.meterCurrent !== undefined;
  const quantity = input.quantity ?? (measured ? input.meterCurrent! - input.meterPrevious! : null);

  if (measured && input.meterCurrent! < input.meterPrevious!) {
    throw invalid(
      'The current reading is lower than the previous one. A meter that goes backwards is a '
      + 'typo or a replaced meter, and neither is a bill.',
    );
  }

  const computed = quantity !== null && input.unitRateMinor !== undefined
    ? BigInt(Math.round(quantity * Number(input.unitRateMinor)))
    : null;

  if (input.amountMinor === undefined) {
    if (computed === null) {
      throw invalid('Give an amount, or a reading and a rate to work one out from.');
    }
    if (computed <= 0n) throw invalid('That works out to nothing. Check the reading and the rate.');
    return { amountMinor: computed, quantity };
  }

  if (computed !== null && computed !== input.amountMinor) {
    throw invalid(
      `The amount and the arithmetic disagree: ${quantity} at that rate comes to a different `
      + 'figure. Correct one of them — an invoice whose lines do not add up to their own total '
      + 'is the thing a tenant queries.',
    );
  }
  if (input.amountMinor <= 0n) throw invalid('A charge has to be more than nothing.');
  return { amountMinor: input.amountMinor, quantity };
}

/**
 * Captures one charge for one lease and month, replacing what was there.
 *
 * Typing water twice for March is a correction, not a second charge. The
 * uniqueness is a partial index in the schema rather than a check here,
 * because two people doing the month together is the ordinary case.
 */
export async function captureCharge(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  params: { periodStart: string } & CaptureInput,
): Promise<{ id: string; amountMinor: Minor }> {
  await requirePermission(tx, organisationId, 'billing.preview');
  const period = monthStart(params.periodStart);
  const input = captureSchema.parse(params);

  const category = chargeCategoryByKey(input.category);
  if (!category) throw invalid(`"${input.category}" is not a charge category.`);
  if (category.key === 'rent') {
    throw invalid(
      'Rent comes from the lease and its schedule, not from a monthly capture. Changing what '
      + 'somebody pays is a change to their lease.',
    );
  }

  const [lease] = await tx<{ id: string; status: string; currency_code: string }[]>`
    select id, status, currency_code from leases
     where id = ${input.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!lease) throw notFound('Lease');
  if (lease.status === 'draft' || lease.status === 'cancelled') {
    throw invalid(`A lease in state "${lease.status}" cannot be charged.`);
  }

  const { amountMinor, quantity } = resolveAmount(input);

  const [row] = await tx<{ id: string }[]>`
    insert into pending_charges (
      organisation_id, lease_id, period_start, category, description, quantity, unit,
      unit_rate_minor, meter_previous, meter_current, amount_minor, currency_code, note,
      created_by, updated_by
    ) values (
      ${organisationId}::uuid, ${input.leaseId}::uuid, ${period}::date, ${input.category},
      ${input.description?.trim() || category.defaultDescription},
      ${quantity ?? null}, ${input.unit ?? category.unit ?? null},
      ${input.unitRateMinor?.toString() ?? null},
      ${input.meterPrevious ?? null}, ${input.meterCurrent ?? null},
      ${amountMinor.toString()}, ${lease.currency_code}, ${input.note ?? null},
      ${actorUserId}::uuid, ${actorUserId}::uuid
    )
    on conflict (lease_id, period_start, category) where posted_at is null
    do update set
      description = excluded.description,
      quantity = excluded.quantity,
      unit = excluded.unit,
      unit_rate_minor = excluded.unit_rate_minor,
      meter_previous = excluded.meter_previous,
      meter_current = excluded.meter_current,
      amount_minor = excluded.amount_minor,
      note = excluded.note,
      updated_by = ${actorUserId}::uuid
    returning id::text
  `;
  if (!row) throw invalid('That charge could not be captured.');

  return { id: row.id, amountMinor };
}

/** Everything typed for a month, billed or not, newest first within a lease. */
export async function pendingCharges(
  tx: Sql,
  organisationId: string,
  params: { periodStart: string; includePosted?: boolean },
): Promise<PendingCharge[]> {
  await requirePermission(tx, organisationId, 'billing.preview');
  const period = monthStart(params.periodStart);

  const rows = await tx<{
    id: string; lease_id: string; lease_reference: string; unit_code: string;
    property_name: string; period_start: string; category: string; description: string;
    quantity: string | null; unit: string | null; unit_rate_minor: string | null;
    meter_previous: string | null; meter_current: string | null; amount_minor: string;
    currency_code: string; note: string | null; captured_by_name: string | null;
    updated_at: string; posted_at: string | null; charge_document_id: string | null;
  }[]>`
    select pc.id::text, pc.lease_id::text, l.reference as lease_reference, u.code as unit_code,
           p.name as property_name, pc.period_start::text, pc.category, pc.description,
           pc.quantity::text, pc.unit, pc.unit_rate_minor::text,
           pc.meter_previous::text, pc.meter_current::text, pc.amount_minor::text,
           pc.currency_code, pc.note, who.full_name as captured_by_name,
           pc.updated_at::text, pc.posted_at::text, pc.charge_document_id::text
      from pending_charges pc
      join leases l on l.id = pc.lease_id
      join units u on u.id = l.unit_id
      join properties p on p.id = l.property_id
      left join user_profiles who on who.auth_user_id = pc.created_by
     where pc.organisation_id = ${organisationId}::uuid
       and pc.period_start = ${period}::date
       ${params.includePosted ? tx`` : tx`and pc.posted_at is null`}
     order by p.name, u.code, pc.category
  `;

  return rows.map((r) => ({
    id: r.id,
    leaseId: r.lease_id,
    leaseReference: r.lease_reference,
    unitLabel: `${r.property_name} / ${r.unit_code}`,
    propertyName: r.property_name,
    periodStart: r.period_start,
    category: r.category,
    categoryLabel: chargeCategoryByKey(r.category)?.label ?? r.category,
    description: r.description,
    quantity: r.quantity === null ? null : Number(r.quantity),
    unit: r.unit,
    unitRateMinor: r.unit_rate_minor === null ? null : Number(r.unit_rate_minor),
    meterPrevious: r.meter_previous === null ? null : Number(r.meter_previous),
    meterCurrent: r.meter_current === null ? null : Number(r.meter_current),
    amountMinor: Number(r.amount_minor),
    currencyCode: r.currency_code,
    note: r.note,
    capturedByName: r.captured_by_name,
    updatedAt: r.updated_at,
    postedAt: r.posted_at,
    chargeDocumentId: r.charge_document_id,
  }));
}

/**
 * The leases a month should be captured against, with last month's readings.
 *
 * The previous reading is the thing that makes this usable: a meter is read as
 * a number on a dial, and turning that into consumption needs what it said
 * last time. Carried forward from the last captured reading for that lease and
 * category, whether or not it has been billed.
 */
export interface CaptureRow {
  leaseId: string;
  leaseReference: string;
  unitLabel: string;
  propertyName: string;
  residentName: string | null;
  /** The last reading recorded for this lease and category, by month. */
  lastReadings: Record<string, { reading: number | null; at: string }>;
}

export async function leasesToCapture(
  tx: Sql,
  organisationId: string,
  params: { periodStart: string; propertyId?: string },
): Promise<CaptureRow[]> {
  await requirePermission(tx, organisationId, 'billing.preview');
  const period = monthStart(params.periodStart);

  const rows = await tx<{
    lease_id: string; reference: string; unit_code: string; property_name: string;
    resident_name: string | null; readings: Array<{ category: string; reading: string | null; at: string }> | null;
  }[]>`
    select l.id::text as lease_id, l.reference, u.code as unit_code, p.name as property_name,
           (select r.first_name || ' ' || r.last_name
              from lease_parties lp
              join resident_profiles r on r.id = lp.resident_id
             where lp.lease_id = l.id and lp.removed_on is null
             order by case lp.role when 'primary_resident' then 0 else 1 end
             limit 1) as resident_name,
           (select coalesce(json_agg(json_build_object(
                     'category', x.category, 'reading', x.meter_current::text,
                     'at', x.period_start::text
                   )), '[]'::json)
              from (
                select distinct on (pc.category) pc.category, pc.meter_current, pc.period_start
                  from pending_charges pc
                 where pc.lease_id = l.id and pc.meter_current is not null
                   and pc.period_start < ${period}::date
                 order by pc.category, pc.period_start desc
              ) x) as readings
      from leases l
      join units u on u.id = l.unit_id
      join properties p on p.id = l.property_id
     where l.organisation_id = ${organisationId}::uuid
       and l.status = 'active'
       ${params.propertyId ? tx`and l.property_id = ${params.propertyId}::uuid` : tx``}
       -- Billed for a month it was live in: a lease that ended before the
       -- month began has no water to recover.
       and l.start_date <= (${period}::date + interval '1 month' - interval '1 day')
       and (l.end_date is null or l.end_date >= ${period}::date)
     order by p.name, u.code
  `;

  return rows.map((r) => ({
    leaseId: r.lease_id,
    leaseReference: r.reference,
    unitLabel: `${r.property_name} / ${r.unit_code}`,
    propertyName: r.property_name,
    residentName: r.resident_name,
    lastReadings: Object.fromEntries(
      (r.readings ?? []).map((x) => [
        x.category, { reading: x.reading === null ? null : Number(x.reading), at: x.at },
      ]),
    ),
  }));
}

/**
 * Removes a captured charge, which is removing a draft.
 *
 * Only before it has been billed: once a run has turned it into a document the
 * row says where that line came from, and the correction for a document is a
 * credit note rather than an erased draft. Enforced by the delete policy and
 * by a trigger, so it holds on the privileged connection too.
 */
export async function discardCapturedCharge(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  pendingChargeId: string,
): Promise<void> {
  await requirePermission(tx, organisationId, 'billing.preview');

  const [row] = await tx<{
    lease_id: string; category: string; amount_minor: string; period_start: string;
    posted_at: string | null;
  }[]>`
    select lease_id::text, category, amount_minor::text, period_start::text, posted_at::text
      from pending_charges
     where id = ${pendingChargeId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!row) throw notFound('Captured charge');
  if (row.posted_at) {
    throw invalid(
      'That charge has been billed. The invoice is the record now, and the way to reverse it '
      + 'is a credit note.',
    );
  }

  await tx`
    delete from pending_charges
     where id = ${pendingChargeId}::uuid and organisation_id = ${organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId,
    actorUserId,
    action: 'billing.capture.discarded',
    resourceType: 'lease',
    resourceId: row.lease_id,
    reason: null,
    before: {
      category: row.category, amountMinor: row.amount_minor, periodStart: row.period_start,
    },
    after: null,
  });
}
