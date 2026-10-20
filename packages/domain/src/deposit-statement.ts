import type { Sql } from '@propertyos/db';
import { notFound } from './errors';
import type { Minor } from './money';

/**
 * A tenant's deposit, accounted for.
 *
 * This is the one piece of money in the product a tenant could not see at all.
 * They were told what was held and nothing about what happened to it — which
 * is exactly the document somebody needs at the end of a lease, when a deposit
 * comes back smaller than it went in and nobody can say why.
 *
 * It reports what the ledger holds and computes only sums of it:
 *
 *   received + interest − deductions − refunds = held
 *
 * Each deduction carries the description recorded when it was approved. Where
 * an operator recorded no reason, this says so in those words rather than
 * leaving a blank that reads like a system failure — a deduction nobody
 * explained is a fact about the landlord, not about the renderer.
 *
 * What it deliberately leaves out: who approved anything, internal approval
 * notes, and any operator's name. A tenant is entitled to the money's history,
 * not to the organisation's.
 */

export interface DepositStatementEvent {
  eventType: string;
  label: string;
  /**
   * How much, always as a positive number.
   *
   * The ledger stores a deduction negative, because that is what it does to
   * the account. A reader does not think in signs: they think "R1,250 came
   * out". So the magnitude is reported and `reduces` carries the direction,
   * and no screen has to remember which events are stored which way.
   */
  amountMinor: Minor;
  effectiveOn: string;
  description: string;
  /** The bank reference of a refund, where one was recorded. */
  reference: string | null;
  /** True where this takes money OUT of the deposit. */
  reduces: boolean;
}

export interface DepositStatement {
  leaseReference: string;
  propertyName: string;
  unitCode: string;
  propertyAddress: string[];
  residentName: string;
  currencyCode: string;
  requiredMinor: Minor;
  openedOn: string;
  closedOn: string | null;
  events: DepositStatementEvent[];
  receivedMinor: Minor;
  interestMinor: Minor;
  deductedMinor: Minor;
  refundedMinor: Minor;
  transferredToRentMinor: Minor;
  /** What is still held. The ledger's figure, not a guess from the events. */
  heldMinor: Minor;
  /** True where the sums above do not reconcile — said out loud, never hidden. */
  reconciles: boolean;
}

const LABELS: Record<string, string> = {
  received: 'Deposit received',
  interest_credited: 'Interest credited to you',
  deduction: 'Deducted',
  refund: 'Refunded to you',
  transfer_to_rent: 'Transferred to rent owed',
  adjustment: 'Adjustment',
};

/** The event types that take money out of the deposit. */
const REDUCES = new Set(['deduction', 'refund', 'transfer_to_rent']);

interface EventRow {
  event_type: string; amount_minor: string; effective_on: string;
  description: string | null; refund_reference: string | null;
}

interface AccountRow {
  currency_code: string; required_minor: string; opened_on: string; closed_on: string | null;
  lease_reference: string; property_name: string; unit_code: string;
  address_line1: string; address_line2: string | null; suburb: string | null;
  city: string; province: string | null; postal_code: string | null;
  resident_name: string | null;
}

/** The lease's identifying facts, shared by both readers. */
async function leaseFacts(tx: Sql, leaseId: string): Promise<AccountRow | undefined> {
  const [row] = await tx<AccountRow[]>`
    select da.currency_code, da.required_minor::text, da.opened_on::text, da.closed_on::text,
           l.reference as lease_reference,
           p.name as property_name, u.code as unit_code,
           p.address_line1, p.address_line2, p.suburb, p.city, p.province, p.postal_code,
           (rp.first_name || ' ' || rp.last_name) as resident_name
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      join deposit_accounts da on da.lease_id = l.id
      left join lease_parties lp on lp.lease_id = l.id
        and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
     where l.id = ${leaseId}::uuid
  `;
  return row;
}

/** The deposit statement for an operator, under their own row-level security. */
export async function loadDepositStatementForOperator(
  tx: Sql, organisationId: string, leaseId: string,
): Promise<DepositStatement> {
  const facts = await leaseFacts(tx, leaseId);
  if (!facts) throw notFound('There is no deposit account on this lease.');

  const events = await tx<EventRow[]>`
    select de.event_type::text, de.amount_minor::text, de.effective_on::text,
           de.description, de.refund_reference
      from deposit_events de
      join deposit_accounts da on da.id = de.deposit_account_id
     where da.lease_id = ${leaseId}::uuid
       and de.organisation_id = ${organisationId}::uuid
     order by de.effective_on, de.created_at
  `;
  return assemble(facts, events);
}

/**
 * The same statement, read by the tenant whose money it is.
 *
 * `deposit_accounts` and `deposit_events` are closed to a resident — the first
 * carries the landlord's own bank reference, the second carries approval notes
 * — so this goes through the function that checks the portal link and returns
 * only the money's history.
 */
export async function loadDepositStatementForResident(
  tx: Sql, leaseId: string,
): Promise<DepositStatement> {
  const facts = await leaseFacts(tx, leaseId);
  if (!facts) throw notFound('There is no deposit account on this lease.');

  const events = await tx<EventRow[]>`
    select event_type, amount_minor::text, effective_on::text, description, refund_reference
      from app.resident_deposit_history(${leaseId}::uuid)
     where event_type is not null
  `;
  return assemble(facts, events);
}

function assemble(facts: AccountRow, rows: EventRow[]): DepositStatement {
  const events: DepositStatementEvent[] = rows.map((row) => ({
    eventType: row.event_type,
    label: LABELS[row.event_type] ?? row.event_type.replace(/_/g, ' '),
    amountMinor: absolute(BigInt(row.amount_minor)),
    effectiveOn: row.effective_on,
    description: row.description?.trim()
      // Said plainly rather than left blank. A deduction with no reason
      // recorded is a fact the tenant should be able to point at.
      || (row.event_type === 'deduction' ? 'No reason was recorded for this deduction.' : ''),
    reference: row.refund_reference,
    // An adjustment can go either way, so its direction comes from the sign
    // it was recorded with rather than from its type.
    reduces: REDUCES.has(row.event_type) || BigInt(row.amount_minor) < 0n,
  }));

  const sum = (type: string) => rows
    .filter((row) => row.event_type === type)
    .reduce((total, row) => total + absolute(BigInt(row.amount_minor)), 0n);

  const receivedMinor = sum('received');
  const interestMinor = sum('interest_credited');
  const deductedMinor = sum('deduction');
  const refundedMinor = sum('refund');
  const transferredToRentMinor = sum('transfer_to_rent');
  // Adjustments carry their own sign, so they are added as recorded.
  const adjustments = rows
    .filter((row) => row.event_type === 'adjustment')
    .reduce((total, row) => total + BigInt(row.amount_minor), 0n);

  const heldMinor = receivedMinor + interestMinor + adjustments
    - deductedMinor - refundedMinor - transferredToRentMinor;

  return {
    leaseReference: facts.lease_reference,
    propertyName: facts.property_name,
    unitCode: facts.unit_code,
    propertyAddress: [
      facts.address_line1,
      facts.address_line2,
      [facts.suburb, facts.city].filter(Boolean).join(', '),
      [facts.province, facts.postal_code].filter(Boolean).join(' '),
    ].filter((line): line is string => Boolean(line && line.trim())),
    residentName: facts.resident_name ?? 'Resident',
    currencyCode: facts.currency_code,
    requiredMinor: BigInt(facts.required_minor),
    openedOn: facts.opened_on,
    closedOn: facts.closed_on,
    events,
    receivedMinor,
    interestMinor,
    deductedMinor,
    refundedMinor,
    transferredToRentMinor,
    heldMinor,
    // It cannot fail to reconcile by construction, but a negative balance
    // means something was recorded that should not have been, and the document
    // says so rather than printing a negative deposit as though it were normal.
    reconciles: heldMinor >= 0n,
  };
}

function absolute(value: Minor): Minor {
  return value < 0n ? -value : value;
}
