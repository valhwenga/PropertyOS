import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { lastFour, sealField } from '@propertyos/integrations';
import { recordAudit } from './audit';
import { invalid, notFound, parsed } from './errors';
import { requireFreshAuthentication, requirePermission } from './permissions';

/**
 * The organisation's banking details.
 *
 * A diverted account number is the most profitable attack there is on a letting
 * business: change four digits and every resident pays a stranger, in good
 * faith, with a valid reference. So the rules here are deliberately heavier
 * than for ordinary settings.
 *
 *  - The full number is sealed on the way in and never leaves this module.
 *    Reads return the last four digits. There is no "show me the number"
 *    endpoint, because the only legitimate consumer is the lease agreement
 *    generator, which opens it under its own permission and audit event.
 *  - Changing a number requires its own permission, a reason, and FRESH
 *    authentication — a second factor proved minutes ago, not an eight-hour
 *    session left open on an unattended machine.
 *  - Verification records the METHOD. "An operator said so" and "the bank
 *    confirmed it" are both honest answers; presenting the first as the second
 *    is not, so the interface prints what was actually done.
 *  - Every change appends to `bank_account_changes`, which has no update or
 *    delete path at all.
 *
 * Creating the first account is not a change to anything, so it does not demand
 * fresh authentication; it still demands the permission, a reason and a history
 * row. Everything after that does.
 */

export type VerificationMethod =
  | 'none' | 'landlord_confirmed' | 'bank_document' | 'micro_deposit' | 'provider_api';

/** What each method actually attests to. Printed to the operator verbatim. */
export const VERIFICATION_METHODS: Record<VerificationMethod, string> = {
  none: 'Not verified — nobody has checked these details',
  landlord_confirmed: 'The account holder confirmed these details',
  bank_document: 'A bank letter or stamped statement was sighted',
  micro_deposit: 'A small payment was sent and the amount confirmed',
  provider_api: 'A bank or payment provider confirmed the account',
};

export interface BankAccountSummary {
  id: string;
  label: string;
  bankName: string;
  accountHolder: string | null;
  /** The only part of the number this module ever returns. */
  accountNumberLast4: string;
  branchCode: string | null;
  currencyCode: string;
  accountRole: 'operating' | 'deposit';
  isActive: boolean;
  /** Null when the account has never been verified. */
  verifiedAt: string | null;
  verificationMethod: VerificationMethod;
  verificationNote: string | null;
  /** The sentence to show. Never the bare word "verified". */
  verificationLabel: string;
  /** True only when the full number is stored; an imported account may not be. */
  hasStoredNumber: boolean;
  updatedAt: string;
}

export interface BankAccountChange {
  id: string;
  changeType:
    | 'created' | 'account_number_changed' | 'details_changed'
    | 'verified' | 'verification_withdrawn' | 'deactivated' | 'reactivated';
  previousLast4: string | null;
  newLast4: string | null;
  previousBankName: string | null;
  newBankName: string | null;
  previousAccountHolder: string | null;
  newAccountHolder: string | null;
  reason: string;
  freshAuthentication: boolean;
  changedAt: string;
  changedByName: string | null;
}

const ACCOUNT_NUMBER = /^[0-9][0-9 -]{3,33}$/;

/** Every change needs a reason, and five characters is not a reason. */
const reasonSchema = z.string().trim().min(5, 'Say why this is changing.').max(500);
const digitsOf = (v: string): string => v.replace(/[^0-9]/g, '');

const detailsSchema = z.object({
  label: z.string().trim().min(2).max(80),
  bankName: z.string().trim().min(2).max(120),
  accountHolder: z.string().trim().min(2).max(160),
  branchCode: z.string().trim().regex(/^[0-9]{4,10}$/, 'A branch code is 4 to 10 digits.').optional(),
  accountRole: z.enum(['operating', 'deposit']).default('operating'),
  reason: z.string().trim().min(5).max(500),
});

const numberSchema = z.string().trim().regex(
  ACCOUNT_NUMBER, 'An account number is 4 to 34 digits, optionally spaced or hyphenated.',
);

/* ------------------------------------------------------------------- reading */

export async function listBankAccounts(
  tx: Sql, organisationId: string,
): Promise<BankAccountSummary[]> {
  await requirePermission(tx, organisationId, 'bank_account.read');
  // account_number_cipher is deliberately absent from this projection. The
  // sealed bytes have no business travelling to a screen, a log or a cache.
  const rows = await tx<Record<string, string | boolean | null>[]>`
    select id, label, bank_name, account_holder, account_number_last4, branch_code,
           currency_code, account_role, is_active, verified_at::text as verified_at,
           verification_method, verification_note, updated_at::text as updated_at,
           (account_number_cipher is not null) as has_stored_number
      from bank_accounts
     where organisation_id = ${organisationId}
     order by is_active desc, account_role, label
  `;
  return rows.map((r) => {
    const method = (r.verification_method as VerificationMethod) ?? 'none';
    return {
      id: r.id as string,
      label: r.label as string,
      bankName: r.bank_name as string,
      accountHolder: (r.account_holder as string | null) ?? null,
      accountNumberLast4: r.account_number_last4 as string,
      branchCode: (r.branch_code as string | null) ?? null,
      currencyCode: r.currency_code as string,
      accountRole: r.account_role as 'operating' | 'deposit',
      isActive: Boolean(r.is_active),
      verifiedAt: (r.verified_at as string | null) ?? null,
      verificationMethod: method,
      verificationNote: (r.verification_note as string | null) ?? null,
      verificationLabel: VERIFICATION_METHODS[method],
      hasStoredNumber: Boolean(r.has_stored_number),
      updatedAt: r.updated_at as string,
    };
  });
}

export async function bankAccountHistory(
  tx: Sql, organisationId: string, bankAccountId: string,
): Promise<BankAccountChange[]> {
  await requirePermission(tx, organisationId, 'bank_account.read');
  const rows = await tx<Record<string, string | boolean | null>[]>`
    select c.id, c.change_type, c.previous_last4, c.new_last4,
           c.previous_bank_name, c.new_bank_name,
           c.previous_account_holder, c.new_account_holder,
           c.reason, c.fresh_authentication, c.changed_at::text as changed_at,
           p.full_name as changed_by_name
      from bank_account_changes c
      left join user_profiles p on p.auth_user_id = c.changed_by
     where c.organisation_id = ${organisationId} and c.bank_account_id = ${bankAccountId}
     order by c.changed_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    changeType: r.change_type as BankAccountChange['changeType'],
    previousLast4: (r.previous_last4 as string | null) ?? null,
    newLast4: (r.new_last4 as string | null) ?? null,
    previousBankName: (r.previous_bank_name as string | null) ?? null,
    newBankName: (r.new_bank_name as string | null) ?? null,
    previousAccountHolder: (r.previous_account_holder as string | null) ?? null,
    newAccountHolder: (r.new_account_holder as string | null) ?? null,
    reason: r.reason as string,
    freshAuthentication: Boolean(r.fresh_authentication),
    changedAt: r.changed_at as string,
    changedByName: (r.changed_by_name as string | null) ?? null,
  }));
}

/* ------------------------------------------------------------------ writing */

async function appendChange(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  row: {
    bankAccountId: string;
    changeType: BankAccountChange['changeType'];
    reason: string;
    freshAuthentication: boolean;
    previousLast4?: string | null; newLast4?: string | null;
    previousBankName?: string | null; newBankName?: string | null;
    previousAccountHolder?: string | null; newAccountHolder?: string | null;
  },
): Promise<void> {
  await tx`
    insert into bank_account_changes (
      organisation_id, bank_account_id, change_type, previous_last4, new_last4,
      previous_bank_name, new_bank_name, previous_account_holder, new_account_holder,
      reason, fresh_authentication, changed_by
    ) values (
      ${organisationId}, ${row.bankAccountId}, ${row.changeType},
      ${row.previousLast4 ?? null}, ${row.newLast4 ?? null},
      ${row.previousBankName ?? null}, ${row.newBankName ?? null},
      ${row.previousAccountHolder ?? null}, ${row.newAccountHolder ?? null},
      ${row.reason}, ${row.freshAuthentication}, ${actorUserId}
    )
  `;
}

/** The default financial book, which every bank account belongs to. */
async function defaultBook(tx: Sql, organisationId: string): Promise<{ id: string; currency_code: string }> {
  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
     where organisation_id = ${organisationId} and is_default
  `;
  if (!book) throw notFound('This organisation has no financial book.');
  return book;
}

export async function addBankAccount(
  tx: Sql, organisationId: string, actorUserId: string,
  input: z.input<typeof detailsSchema> & { accountNumber: string },
): Promise<{ bankAccountId: string }> {
  await requirePermission(tx, organisationId, 'bank_account.manage');
  const d = parsed(detailsSchema, input);
  const number = parsed(numberSchema, input.accountNumber);
  const digits = digitsOf(number);
  if (digits.length < 4) throw invalid('An account number needs at least four digits.');

  const book = await defaultBook(tx, organisationId);

  const [row] = await tx<{ id: string }[]>`
    insert into bank_accounts (
      organisation_id, book_id, label, bank_name, account_holder,
      account_number_last4, account_number_cipher, branch_code, currency_code,
      account_role, verification_method, updated_by
    ) values (
      ${organisationId}, ${book.id}, ${d.label}, ${d.bankName}, ${d.accountHolder},
      ${lastFour(digits)}, ${sealField(digits, `bank_account:${organisationId}`)},
      ${d.branchCode ?? null}, ${book.currency_code}, ${d.accountRole}, 'none', ${actorUserId}
    )
    returning id
  `;
  if (!row) throw invalid('The bank account could not be created.');

  await appendChange(tx, organisationId, actorUserId, {
    bankAccountId: row.id, changeType: 'created', reason: d.reason,
    // Creating the first account is not a change to an existing one, so it is
    // not gated on freshness. The history records that plainly rather than
    // claiming an assurance that was never asked for.
    freshAuthentication: false,
    newLast4: lastFour(digits), newBankName: d.bankName, newAccountHolder: d.accountHolder,
  });
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'bank_account.created', resourceType: 'bank_account', resourceId: row.id,
    reason: d.reason, after: { last4: lastFour(digits), bankName: d.bankName },
  });
  return { bankAccountId: row.id };
}

/**
 * Changes the account number.
 *
 * The heaviest operation in the product that does not move money, and the one
 * §22 names as a threat in its own right. Fresh authentication, a reason, a
 * history row, and the verification is withdrawn: a number that has changed has
 * not been verified, whatever was true of the number before it.
 */
export async function changeBankAccountNumber(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { bankAccountId: string; accountNumber: string; reason: string },
): Promise<{ changed: boolean }> {
  await requirePermission(tx, organisationId, 'bank_account.manage');
  await requireFreshAuthentication(tx);

  const reason = parsed(reasonSchema, input.reason);
  const digits = digitsOf(parsed(numberSchema, input.accountNumber));
  if (digits.length < 4) throw invalid('An account number needs at least four digits.');

  const [existing] = await tx<{ account_number_last4: string; bank_name: string }[]>`
    select account_number_last4, bank_name from bank_accounts
     where id = ${input.bankAccountId} and organisation_id = ${organisationId}
     for update
  `;
  if (!existing) throw notFound('That bank account does not exist.');

  // Comparing sealed values is not possible by design (the nonce differs every
  // time), and the last four digits are not identity. So this records a change
  // whenever it is asked to, rather than pretending to detect a no-op it cannot
  // actually see.
  await tx`
    update bank_accounts
       set account_number_last4 = ${lastFour(digits)},
           account_number_cipher = ${sealField(digits, `bank_account:${organisationId}`)},
           verified_at = null, verified_by = null,
           verification_method = 'none', verification_note = null,
           updated_at = now(), updated_by = ${actorUserId}
     where id = ${input.bankAccountId} and organisation_id = ${organisationId}
  `;

  await appendChange(tx, organisationId, actorUserId, {
    bankAccountId: input.bankAccountId, changeType: 'account_number_changed', reason,
    freshAuthentication: true,
    previousLast4: existing.account_number_last4, newLast4: lastFour(digits),
  });
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'bank_account.number_changed', resourceType: 'bank_account',
    resourceId: input.bankAccountId, reason,
    before: { last4: existing.account_number_last4 },
    after: { last4: lastFour(digits), verificationWithdrawn: true },
  });
  return { changed: true };
}

/** Label, bank name, holder and branch code. Not the number — that is above. */
export async function updateBankAccountDetails(
  tx: Sql, organisationId: string, actorUserId: string,
  input: Omit<z.input<typeof detailsSchema>, 'accountRole'> & { bankAccountId: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'bank_account.manage');
  await requireFreshAuthentication(tx);
  const d = parsed(detailsSchema.omit({ accountRole: true }), input);

  const [existing] = await tx<{ bank_name: string; account_holder: string | null }[]>`
    select bank_name, account_holder from bank_accounts
     where id = ${input.bankAccountId} and organisation_id = ${organisationId}
     for update
  `;
  if (!existing) throw notFound('That bank account does not exist.');

  await tx`
    update bank_accounts
       set label = ${d.label}, bank_name = ${d.bankName},
           account_holder = ${d.accountHolder}, branch_code = ${d.branchCode ?? null},
           updated_at = now(), updated_by = ${actorUserId}
     where id = ${input.bankAccountId} and organisation_id = ${organisationId}
  `;
  await appendChange(tx, organisationId, actorUserId, {
    bankAccountId: input.bankAccountId, changeType: 'details_changed', reason: d.reason,
    freshAuthentication: true,
    previousBankName: existing.bank_name, newBankName: d.bankName,
    previousAccountHolder: existing.account_holder, newAccountHolder: d.accountHolder,
  });
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'bank_account.details_changed', resourceType: 'bank_account',
    resourceId: input.bankAccountId, reason: d.reason,
    before: { bankName: existing.bank_name }, after: { bankName: d.bankName },
  });
}

/**
 * Records that the details were checked, and by what means.
 *
 * `method` is not decoration. It is the difference between a claim the product
 * may repeat to a resident and a claim it may not, so it is stored, shown and
 * never defaulted to something stronger than what happened.
 */
export async function verifyBankAccount(
  tx: Sql, organisationId: string, actorUserId: string,
  input: {
    bankAccountId: string;
    /** Validated at runtime: this arrives from a form, not from a type. */
    method: string;
    note?: string;
    reason: string;
  },
): Promise<void> {
  await requirePermission(tx, organisationId, 'bank_account.verify');
  await requireFreshAuthentication(tx);
  const reason = parsed(reasonSchema, input.reason);
  const note = input.note ? parsed(z.string().trim().max(500), input.note) : null;
  // 'none' is a real stored state but not a verification, so it is refused
  // here rather than silently recording a verification that attests to nothing.
  const method = parsed(
    z.enum(['landlord_confirmed', 'bank_document', 'micro_deposit', 'provider_api'], {
      message: 'Choose how these details were verified.',
    }),
    input.method,
  );

  const [row] = await tx<{ id: string; account_number_last4: string }[]>`
    update bank_accounts
       set verified_at = now(), verified_by = ${actorUserId},
           verification_method = ${method}, verification_note = ${note},
           updated_at = now(), updated_by = ${actorUserId}
     where id = ${input.bankAccountId} and organisation_id = ${organisationId}
    returning id, account_number_last4
  `;
  if (!row) throw notFound('That bank account does not exist.');

  await appendChange(tx, organisationId, actorUserId, {
    bankAccountId: input.bankAccountId, changeType: 'verified', reason,
    freshAuthentication: true, newLast4: row.account_number_last4,
  });
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'bank_account.verified', resourceType: 'bank_account',
    resourceId: input.bankAccountId, reason,
    after: { method, last4: row.account_number_last4 },
  });
}

/**
 * Takes an account out of use without deleting it.
 *
 * §3: "Do not treat account suspension as deletion of properties, contracts or
 * financial records." Statements, imports and reconciliation history all point
 * at this row and must keep resolving.
 */
export async function setBankAccountActive(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { bankAccountId: string; active: boolean; reason: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'bank_account.manage');
  await requireFreshAuthentication(tx);
  const reason = parsed(reasonSchema, input.reason);

  const [row] = await tx<{ id: string }[]>`
    update bank_accounts
       set is_active = ${input.active}, updated_at = now(), updated_by = ${actorUserId}
     where id = ${input.bankAccountId} and organisation_id = ${organisationId}
    returning id
  `;
  if (!row) throw notFound('That bank account does not exist.');

  await appendChange(tx, organisationId, actorUserId, {
    bankAccountId: input.bankAccountId,
    changeType: input.active ? 'reactivated' : 'deactivated',
    reason, freshAuthentication: true,
  });
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: input.active ? 'bank_account.reactivated' : 'bank_account.deactivated',
    resourceType: 'bank_account', resourceId: input.bankAccountId, reason,
  });
}
