import type { Sql } from '@propertyos/db';
import { openField } from '@propertyos/integrations';
import { recordAudit } from './audit';
import { DomainError, notFound } from './errors';

/**
 * Reads the resident portal performs that cross a boundary.
 *
 * A resident is not a member of the organisation. Every policy that protects
 * customer data filters them out, correctly, and each of these exists because
 * the portal has to answer a question they are entitled to ask while the table
 * holding the answer also holds something they must never see.
 */

export interface PaymentInstructions {
  bankName: string;
  accountHolder: string;
  accountNumberLast4: string;
  branchCode: string | null;
  verifiedAt: string;
  verificationMethod: string | null;
  paymentReference: string;
}

/**
 * Where to pay, without the number.
 *
 * Enough to CHECK details somebody already holds, which is what the
 * anti-redirection question needs, and safe to render on every page load.
 */
export async function residentPaymentInstructions(
  tx: Sql, leaseId: string,
): Promise<PaymentInstructions | null> {
  const [row] = await tx<
    { bank_name: string; account_holder: string; account_number_last4: string;
      branch_code: string | null; verified_at: string; verification_method: string | null;
      payment_reference: string }[]
  >`
    select bank_name, account_holder, account_number_last4, branch_code,
           verified_at, verification_method, payment_reference
    from app.resident_payment_instructions(${leaseId}::uuid)
  `;
  if (!row) return null;
  return {
    bankName: row.bank_name,
    accountHolder: row.account_holder,
    accountNumberLast4: row.account_number_last4,
    branchCode: row.branch_code,
    verifiedAt: row.verified_at,
    verificationMethod: row.verification_method,
    paymentReference: row.payment_reference,
  };
}

/**
 * The full account number, opened once, on purpose, and recorded.
 *
 * A resident cannot pay rent without it, and the first time they pay they have
 * nothing to check against — so "the last four digits" is not an answer. It is
 * already disclosed to this same reader in the lease agreement they signed,
 * generated from this same cipher with this same context; what changes here is
 * that they can get it without finding the paperwork.
 *
 * Three things keep that narrow. The row is resolved by a function that
 * requires an active portal link to this lease, so the id in the URL decides
 * nothing. The number is NOT part of the page's own data: it is fetched when
 * the resident asks for it, so it is absent from every ordinary render. And
 * each disclosure writes an audit entry naming the account — never the number,
 * which must not reach the trail, a log or an analytics payload.
 */
export async function revealResidentAccountNumber(
  tx: Sql, leaseId: string, actorUserId: string,
): Promise<{ accountNumber: string; accountNumberLast4: string }> {
  const [row] = await tx<
    { bank_account_id: string; organisation_id: string; account_number_last4: string;
      account_number_cipher: Uint8Array | null }[]
  >`
    select bank_account_id, organisation_id, account_number_last4, account_number_cipher
    from app.resident_payment_instructions(${leaseId}::uuid)
  `;
  if (!row) throw notFound('Payment instructions');
  if (!row.account_number_cipher) {
    throw new DomainError(
      'not_found',
      'The full account number is not stored for this account. Ask your landlord for it.',
    );
  }

  let accountNumber: string;
  try {
    accountNumber = openField(
      Buffer.from(row.account_number_cipher),
      `bank_account:${row.organisation_id}`,
    );
  } catch {
    // A wrong key or an altered row must read as "cannot show this", never as
    // a number that might be somebody else's.
    throw new DomainError(
      'internal',
      'The stored account number could not be read. Ask your landlord to confirm it.',
    );
  }

  await recordAudit(tx, {
    organisationId: row.organisation_id,
    actorUserId,
    action: 'bank_account.number_shown_to_resident',
    resourceType: 'bank_account',
    resourceId: row.bank_account_id,
    reason: 'Resident opened the payment instructions in the portal.',
    after: { leaseId, last4: row.account_number_last4 },
  });

  return { accountNumber, accountNumberLast4: row.account_number_last4 };
}

/**
 * When somebody is coming, who, and what they said when they finished.
 *
 * The work order also carries the spending ceiling and the approver. Those are
 * the landlord's business and the function that feeds this returns neither.
 */
export async function residentTicketWork(tx: Sql, ticketId: string) {
  const [row] = await tx<
    { appointment_at: string | null; status: string; completed_at: string | null;
      completion_note: string | null; vendor_name: string | null;
      vendor_category: string | null }[]
  >`
    select appointment_at, status, completed_at, completion_note,
           vendor_name, vendor_category
    from app.resident_ticket_work(${ticketId}::uuid)
  `;
  return row ?? null;
}

/** Who to phone out of hours, if the landlord has recorded somebody. */
export async function residentEmergencyContact(
  tx: Sql, leaseId: string,
): Promise<string | null> {
  const [row] = await tx<{ contact: string | null }[]>`
    select app.resident_emergency_contact(${leaseId}::uuid) as contact
  `;
  return row?.contact ?? null;
}

export interface ResidentInspection {
  id: string;
  inspectionType: 'move_in' | 'move_out' | 'routine' | 'other';
  performedOn: string | null;
  finalisedAt: string | null;
  status: string;
  inspectorName: string | null;
  keysHandedOver: string | null;
  items: Array<{
    id: string; room: string; item: string;
    condition: string; damageType: string | null; note: string | null;
    /** The photographs behind this line, which a deduction has to rest on. */
    photos: Array<{ documentId: string; title: string; openable: boolean }>;
  }>;
  /** This resident's own answer, if they have given one. */
  myResponse: { response: string; comment: string | null; respondedAt: string } | null;
}

/**
 * The inspections of this tenancy that the resident is entitled to see, with
 * their own response to each.
 *
 * `respondToInspection` has existed with tests and no screen, so a report
 * recording damage against somebody's deposit could be finalised and there was
 * no way for them to agree or disagree with it — the one document in this
 * product most likely to cost a tenant money, and the only one they could not
 * answer.
 *
 * Read under the resident's own row-level security:
 * `app.resident_inspection_ids()` already limits them to finalised
 * inspections on their own leases, so an inspector's draft is not reachable
 * here and this adds no second opinion about who may see what.
 *
 * `myResponse` is this resident's row only. A co-tenant's answer is their own
 * business, and showing it would turn a dispute between two people on one
 * lease into something each could read about the other.
 */
export async function residentInspections(
  tx: Sql,
  leaseId: string,
  residentId: string,
): Promise<ResidentInspection[]> {
  const rows = await tx<
    { id: string; inspection_type: string; performed_on: string | null;
      finalised_at: string | null; status: string; inspector_name: string | null;
      keys_handed_over: string | null }[]
  >`
    select i.id, i.inspection_type::text, i.performed_on::text, i.finalised_at::text,
           i.status::text, i.keys_handed_over::text,
           (select full_name from user_profiles up where up.auth_user_id = i.inspector_user_id)
             as inspector_name
      from inspections i
     where i.lease_id = ${leaseId}::uuid
       and i.status in ('finalised', 'acknowledged', 'disputed')
     order by coalesce(i.performed_on, i.finalised_at::date) desc
     limit 50
  `;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const items = await tx<
    { inspection_id: string; id: string; room: string; item: string;
      condition: string; damage_type: string | null; note: string | null }[]
  >`
    select inspection_id, id, room, item, condition::text, damage_type::text, note
      from inspection_items
     where inspection_id = any(${ids}::uuid[])
     order by inspection_id, sort_order, room, item
  `;
  // Readable by the resident since migration 0070: these are the evidence
  // behind a deduction from their own deposit, and were visible only to the
  // party making the deduction.
  const photos = await tx<
    { inspection_item_id: string; document_id: string; title: string; quarantined: boolean }[]
  >`
    select ip.inspection_item_id, ip.document_id, d.title, d.quarantined
      from inspection_photos ip
      join documents d on d.id = ip.document_id
     where ip.inspection_item_id in (
             select id from inspection_items where inspection_id = any(${ids}::uuid[])
           )
       and d.deleted_at is null
     order by ip.captured_at
  `;

  const mine = await tx<
    { inspection_id: string; response: string; comment: string | null; responded_at: string }[]
  >`
    select inspection_id, response::text, comment, responded_at::text
      from inspection_acknowledgements
     where inspection_id = any(${ids}::uuid[])
       and resident_id = ${residentId}::uuid
  `;

  return rows.map((r) => ({
    id: r.id,
    inspectionType: r.inspection_type as ResidentInspection['inspectionType'],
    performedOn: r.performed_on,
    finalisedAt: r.finalised_at,
    status: r.status,
    inspectorName: r.inspector_name,
    keysHandedOver: r.keys_handed_over,
    items: items
      .filter((i) => i.inspection_id === r.id)
      .map((i) => ({
        id: i.id, room: i.room, item: i.item, condition: i.condition,
        damageType: i.damage_type, note: i.note,
        photos: photos
          .filter((p) => p.inspection_item_id === i.id)
          .map((p) => ({
            documentId: p.document_id,
            title: p.title,
            // A quarantined file is refused to everybody, so the screen says
            // that instead of offering a link that cannot work.
            openable: !p.quarantined,
          })),
      })),
    myResponse: (() => {
      const answer = mine.find((m) => m.inspection_id === r.id);
      return answer
        ? { response: answer.response, comment: answer.comment, respondedAt: answer.responded_at }
        : null;
    })(),
  }));
}
