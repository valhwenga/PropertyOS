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
