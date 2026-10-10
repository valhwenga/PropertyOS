import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, invalid } from './errors';
import { requirePermission } from './permissions';

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Use lowercase letters, numbers and hyphens.'),
  // Launch defaults for South Africa. Stored explicitly on every organisation so
  // expansion never depends on an implicit assumption.
  countryCode: z.string().length(2).toUpperCase().default('ZA'),
  currencyCode: z.string().length(3).toUpperCase().default('ZAR'),
  timeZone: z.string().min(3).default('Africa/Johannesburg'),
  legalEntityName: z.string().trim().min(2).max(200),
  planKey: z.string().default('starter'),
});

export type CreateOrganisationInput = z.infer<typeof createOrganisationSchema>;

/** The chart of accounts every new book starts with. */
const DEFAULT_ACCOUNTS: Array<{
  code: string; name: string; type: 'asset' | 'liability' | 'income' | 'expense' | 'equity'; role: string;
}> = [
  { code: 'AR_RESIDENT',     name: 'Resident receivable',        type: 'asset',     role: 'resident_receivable' },
  { code: 'BANK_OPERATING',  name: 'Landlord bank control',      type: 'asset',     role: 'bank_control' },
  { code: 'BANK_DEPOSIT',    name: 'Deposit bank control',       type: 'asset',     role: 'deposit_bank_control' },
  { code: 'UNAPPLIED',       name: 'Unapplied resident receipts',type: 'liability', role: 'unapplied_receipts' },
  { code: 'DEPOSIT_LIAB',    name: 'Resident deposit liability', type: 'liability', role: 'deposit_liability' },
  { code: 'SUSPENSE',        name: 'Suspense (unidentified receipts)', type: 'liability', role: 'suspense' },
  { code: 'AP_TRADE',        name: 'Accounts payable',           type: 'liability', role: 'accounts_payable' },
  { code: 'INC_RENT',        name: 'Rental income',              type: 'income',    role: 'rental_income' },
  { code: 'INC_UTILITY',     name: 'Utility recovery income',    type: 'income',    role: 'utility_recovery_income' },
  { code: 'INC_OTHER',       name: 'Other income',               type: 'income',    role: 'other_income' },
  { code: 'EXP_PROPERTY',    name: 'Property operating expense', type: 'expense',   role: 'property_expense' },
  { code: 'EXP_DEP_INTEREST',name: 'Deposit interest expense',   type: 'expense',   role: 'deposit_interest_expense' },
  { code: 'EXP_WRITE_OFF',   name: 'Bad debt written off',       type: 'expense',   role: 'write_off_expense' },
  { code: 'EQ_OPENING',      name: 'Opening balance equity',     type: 'equity',    role: 'opening_equity' },
];

/**
 * Provisions a new customer organisation and makes the caller its administrator.
 *
 * This is the one bootstrap path that necessarily runs before the caller has any
 * membership, so it is executed on a privileged connection by the caller
 * (`provisionOrganisation` in the web layer). It never accepts an existing
 * organisation id: it only ever creates a new one and grants the authenticated
 * user administration of *that* organisation. No other privileged write path
 * exists in the request lifecycle.
 */
export async function createOrganisationWithOwner(
  tx: Sql,
  input: CreateOrganisationInput,
  ownerAuthUserId: string,
): Promise<{ organisationId: string; bookId: string; membershipId: string }> {
  const parsed = createOrganisationSchema.parse(input);

  const [org] = await tx<{ id: string }[]>`
    insert into organisations (name, slug, status, country_code, currency_code, time_zone)
    values (${parsed.name}, ${parsed.slug}, 'trial', ${parsed.countryCode},
            ${parsed.currencyCode}, ${parsed.timeZone})
    returning id
  `;
  if (!org) throw new DomainError('internal', 'Organisation insert returned no row.');

  await tx`
    insert into subscriptions (organisation_id, plan_key, status)
    values (${org.id}, ${parsed.planKey}, 'trialing')
  `;

  const [book] = await tx<{ id: string }[]>`
    insert into financial_books (organisation_id, name, legal_entity_name, currency_code, is_default)
    values (${org.id}, ${'Primary book'}, ${parsed.legalEntityName}, ${parsed.currencyCode}, true)
    returning id
  `;
  if (!book) throw new DomainError('internal', 'Financial book insert returned no row.');

  await tx`
    insert into accounts ${tx(
      DEFAULT_ACCOUNTS.map((a) => ({
        organisation_id: org.id,
        book_id: book.id,
        code: a.code,
        name: a.name,
        account_type: a.type,
        system_role: a.role,
      })),
    )}
  `;

  const [membership] = await tx<{ id: string }[]>`
    insert into memberships (organisation_id, auth_user_id, status)
    values (${org.id}, ${ownerAuthUserId}, 'active')
    returning id
  `;
  if (!membership) throw new DomainError('internal', 'Membership insert returned no row.');

  await tx`
    insert into membership_roles (membership_id, role_key, granted_by)
    values (${membership.id}, 'org_admin', ${ownerAuthUserId})
  `;
  // Organisation-wide resource scope for the founding administrator.
  await tx`
    insert into property_assignments (organisation_id, membership_id, scope_type)
    values (${org.id}, ${membership.id}, 'organisation')
  `;
  // A default portfolio, so a small landlord never has to think about portfolios.
  await tx`
    insert into portfolios (organisation_id, name, code)
    values (${org.id}, 'Default portfolio', 'DEFAULT')
  `;

  await recordAudit(tx, {
    organisationId: org.id,
    actorUserId: ownerAuthUserId,
    action: 'organisation.created',
    resourceType: 'organisation',
    resourceId: org.id,
    after: { name: parsed.name, slug: parsed.slug, currency: parsed.currencyCode },
  });
  await emitEvent(tx, {
    organisationId: org.id,
    eventType: 'organisation.created',
    resourceType: 'organisation',
    resourceId: org.id,
    payload: { plan: parsed.planKey },
  });

  return { organisationId: org.id, bookId: book.id, membershipId: membership.id };
}

export async function getDefaultBook(tx: Sql, organisationId: string): Promise<{ id: string; currencyCode: string }> {
  const [book] = await tx<{ id: string; currency_code: string }[]>`
    select id, currency_code from financial_books
    where organisation_id = ${organisationId}::uuid and is_default
  `;
  if (!book) throw new DomainError('not_found', 'This organisation has no default financial book.');
  return { id: book.id, currencyCode: book.currency_code };
}

export async function updateOrganisationSettings(
  tx: Sql,
  organisationId: string,
  actorUserId: string,
  patch: { name?: string; timeZone?: string },
): Promise<void> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  if (patch.name === undefined && patch.timeZone === undefined) {
    throw invalid('Nothing to update.');
  }
  const [before] = await tx<{ name: string; time_zone: string }[]>`
    select name, time_zone from organisations where id = ${organisationId}::uuid
  `;
  await tx`
    update organisations set
      name = coalesce(${patch.name ?? null}, name),
      time_zone = coalesce(${patch.timeZone ?? null}, time_zone),
      updated_at = now()
    where id = ${organisationId}::uuid
  `;
  await recordAudit(tx, {
    organisationId,
    actorUserId,
    action: 'organisation.settings.updated',
    resourceType: 'organisation',
    resourceId: organisationId,
    before,
    after: patch,
  });
}
