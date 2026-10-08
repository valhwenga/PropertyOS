/**
 * Generating a lease agreement from an organisation's own template.
 *
 * The template holds the wording; this holds the values. Placeholders are
 * written {{group.field}} and resolved from the lease, its parties, the unit and
 * property, the landlord's profile and the agreement terms.
 *
 * Three rules shape the design:
 *
 *  - A generated agreement is a DRAFT, never an executed lease. Nothing here
 *    touches `leases.executed_document_id` or `executed_at`.
 *  - A placeholder with no value is REPORTED, never silently blanked. An
 *    agreement issued with an empty deposit or a missing identity number is
 *    worse than one that refused to generate.
 *  - Identity and bank numbers are opened only here, only for the document, and
 *    only masked in anything written down afterwards.
 */
import { formatDayMonthYear } from './dates';
import { formatMoney } from './money';
import { openField } from '@propertyos/integrations';
import type { Sql } from '@propertyos/db';

export interface MergeField {
  key: string;
  label: string;
  group: string;
  /** Shown in the template editor so an operator knows what they will get. */
  example: string;
  /** A document that omits these is not usable, so their absence is an error. */
  essential?: boolean;
  /** Opens a sealed value, and so demands permission and leaves an audit trail. */
  sensitive?: boolean;
}

/**
 * The catalogue.
 *
 * Modelled on the schedule a South African residential lease actually carries —
 * the parties and their identifiers, the premises, the term, the money, the
 * banking details and the house rules. The field NAMES and what they hold are
 * structural facts about such agreements; no one's drafting is reproduced here.
 */
export const LEASE_MERGE_FIELDS: readonly MergeField[] = [
  // Landlord
  { key: 'landlord.name', label: 'Landlord name', group: 'Landlord', example: 'Maria Erasmus', essential: true },
  { key: 'landlord.registration_number', label: 'Registration number', group: 'Landlord', example: '2019/123456/07' },
  { key: 'landlord.identity_number', label: 'Landlord identity number', group: 'Landlord', example: '680212 0250 082', sensitive: true },
  { key: 'landlord.vat_number', label: 'VAT number', group: 'Landlord', example: '4123456789' },
  { key: 'landlord.physical_address', label: 'Physical address', group: 'Landlord', example: '12 Oak Avenue, Sandton' },
  { key: 'landlord.postal_address', label: 'Postal address', group: 'Landlord', example: 'PO Box 1, Randburg' },
  { key: 'landlord.phone', label: 'Telephone', group: 'Landlord', example: '061 032 6261' },
  { key: 'landlord.email', label: 'Email', group: 'Landlord', example: 'landlord@example.co.za' },
  { key: 'landlord.next_of_kin_name', label: 'Next of kin', group: 'Landlord', example: 'J Erasmus' },
  { key: 'landlord.next_of_kin_phone', label: 'Next of kin telephone', group: 'Landlord', example: '082 000 0000' },
  { key: 'agent.name', label: 'Managing agent', group: 'Landlord', example: 'Human Prop Pty Ltd' },
  { key: 'agent.contact', label: 'Agent contact', group: 'Landlord', example: '010 442 3341' },
  { key: 'agent.registration_number', label: 'Agency registration number', group: 'Landlord', example: '2019/123456/07' },
  { key: 'agent.practitioner', label: 'Responsible practitioner', group: 'Landlord', example: 'N Dlamini' },
  { key: 'agent.certificate_number', label: 'Fidelity Fund certificate', group: 'Landlord', example: 'FFC 2026 884412' },

  // Tenant(s)
  { key: 'tenant.names', label: 'All tenant names', group: 'Tenant', example: 'A T Maetane and Z C Mtombo', essential: true },
  { key: 'tenant.primary_name', label: 'Primary tenant', group: 'Tenant', example: 'Anthony Tebogo Maetane', essential: true },
  { key: 'tenant.primary_identity_number', label: 'Primary tenant identity number', group: 'Tenant', example: '830120 5832 086', sensitive: true, essential: true },
  { key: 'tenant.primary_email', label: 'Primary tenant email', group: 'Tenant', example: 'tenant@example.co.za' },
  { key: 'tenant.primary_phone', label: 'Primary tenant telephone', group: 'Tenant', example: '067 767 2739' },
  { key: 'tenant.identity_numbers', label: 'All tenant identity numbers', group: 'Tenant', example: '830120 5832 086', sensitive: true },
  { key: 'tenant.count', label: 'Number of tenants', group: 'Tenant', example: '2' },

  // Premises
  { key: 'property.unit_number', label: 'Unit / door number', group: 'Premises', example: '40' },
  { key: 'property.building_name', label: 'Complex / building', group: 'Premises', example: 'Antibes' },
  { key: 'property.street_address', label: 'Street address', group: 'Premises', example: '18 West Road South' },
  { key: 'property.suburb', label: 'Suburb', group: 'Premises', example: 'Morningside' },
  { key: 'property.city', label: 'City', group: 'Premises', example: 'Johannesburg' },
  { key: 'property.province', label: 'Province', group: 'Premises', example: 'Gauteng' },
  { key: 'property.postal_code', label: 'Postal code', group: 'Premises', example: '2191' },
  { key: 'property.full_address', label: 'Full address, one line', group: 'Premises', example: 'Unit 40 Antibes, 18 West Road South, Morningside, Johannesburg, 2191', essential: true },

  // Term
  { key: 'term.effective_date', label: 'Commencement date', group: 'Term', example: '01 November 2025', essential: true },
  { key: 'term.termination_date', label: 'Termination date', group: 'Term', example: '31 October 2026', essential: true },
  { key: 'term.initial_months', label: 'Initial period, months', group: 'Term', example: '12', essential: true },
  { key: 'term.key_return_date', label: 'Key return date', group: 'Term', example: '31 October 2026' },
  { key: 'term.deposit_refund_days', label: 'Deposit refund, days', group: 'Term', example: '7' },
  { key: 'term.defects_notice_days', label: 'Defects notice, days', group: 'Term', example: '14' },
  { key: 'term.renewal_option_months', label: 'Renewal option, months', group: 'Term', example: '12' },
  { key: 'term.renewal_notice_months', label: 'Renewal notice, months', group: 'Term', example: '2' },
  { key: 'term.notice_days', label: 'Notice period, days', group: 'Term', example: '20' },

  // Money
  { key: 'money.rent', label: 'Monthly rental', group: 'Money', example: 'R7,200.00', essential: true },
  { key: 'money.deposit', label: 'Deposit', group: 'Money', example: 'R7,700.00', essential: true },
  { key: 'money.admin_fee', label: 'Administration fee', group: 'Money', example: 'R1,500.00' },
  { key: 'money.credit_check_fee', label: 'Credit check fee', group: 'Money', example: 'R0.00' },
  { key: 'money.inspection_fee', label: 'Inspection fee', group: 'Money', example: 'R0.00' },
  { key: 'money.escalation_percent', label: 'Escalation', group: 'Money', example: '10' },
  { key: 'money.arrear_interest_monthly', label: 'Arrear interest, monthly %', group: 'Money', example: '2' },
  { key: 'money.arrear_interest_annual_cap', label: 'Arrear interest cap, annual %', group: 'Money', example: '24' },
  { key: 'money.cancellation_penalty_months', label: 'Cancellation penalty, months', group: 'Money', example: '1' },
  { key: 'money.sales_commission_percent', label: 'Sales commission %', group: 'Money', example: '8' },
  { key: 'money.maintenance_callout_fee', label: 'Maintenance call-out fee', group: 'Money', example: '450.00' },
  { key: 'money.early_cancellation_cap', label: 'Early cancellation charge cap', group: 'Money', example: '9500.00' },

  // Banking
  { key: 'bank.account_holder', label: 'Account holder', group: 'Banking', example: 'M Erasmus' },
  { key: 'bank.name', label: 'Bank', group: 'Banking', example: 'Standard Bank' },
  { key: 'bank.branch_code', label: 'Branch code', group: 'Banking', example: '009953' },
  { key: 'bank.account_number', label: 'Account number', group: 'Banking', example: '40 488 8321', sensitive: true },
  { key: 'bank.payment_method', label: 'Payment method', group: 'Banking', example: 'Debit order' },
  { key: 'bank.place_of_payment', label: 'Place of payment', group: 'Banking', example: 'As nominated in writing' },
  { key: 'bank.payment_reference', label: 'Payment reference', group: 'Banking', example: 'LSE-000001' },
  // Where the deposit goes back to. The account belongs to the tenant, so the
  // number is sealed and the agreement shows the last four digits.
  { key: 'refund.account_holder', label: 'Deposit refund account holder', group: 'Banking', example: 'A T Maetane' },
  { key: 'refund.bank', label: 'Deposit refund bank', group: 'Banking', example: 'Capitec' },
  { key: 'refund.branch_code', label: 'Deposit refund branch code', group: 'Banking', example: '470010' },
  { key: 'refund.account_number', label: 'Deposit refund account number', group: 'Banking', example: '1234567890', sensitive: true },

  // House rules
  { key: 'rules.parking_bays', label: 'Parking bay(s)', group: 'Rules', example: '40' },
  { key: 'rules.max_occupants', label: 'Maximum occupants', group: 'Rules', example: '2' },
  { key: 'rules.permanent_vehicles', label: 'Permanent vehicles', group: 'Rules', example: '1' },
  { key: 'rules.smoking_allowed', label: 'Smoking allowed', group: 'Rules', example: 'No' },
  { key: 'rules.pets_allowed', label: 'Pets allowed', group: 'Rules', example: 'No' },
  { key: 'rules.pets_detail', label: 'Pet details', group: 'Rules', example: '' },
  { key: 'rules.surcharge', label: 'Surcharge', group: 'Rules', example: 'Electricity only' },
  { key: 'rules.special_conditions', label: 'Special conditions', group: 'Rules', example: '' },
  { key: 'rules.named_occupants', label: 'Named occupants', group: 'Rules', example: 'Z C Mtombo, spouse' },
  { key: 'rules.complaints_threshold', label: 'Complaints threshold', group: 'Rules', example: '3' },

  // Legal and document
  { key: 'legal.jurisdiction_court', label: "Magistrate's court", group: 'Legal', example: 'Randburg' },
  { key: 'doc.lease_reference', label: 'Lease reference', group: 'Document', example: 'LSE-000001' },
  { key: 'doc.organisation_name', label: 'Organisation', group: 'Document', example: 'Blue Crane Rentals' },
  { key: 'doc.generated_date', label: 'Date generated', group: 'Document', example: '06 October 2026' },
];

const FIELD_BY_KEY = new Map(LEASE_MERGE_FIELDS.map((f) => [f.key, f]));

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/gi;

export interface RenderResult {
  text: string;
  /** Placeholders in the template that resolved to nothing. */
  missing: string[];
  /** Placeholders the catalogue does not define — almost always a typo. */
  unknown: string[];
}

/**
 * Invisible markers around a merged value, so a renderer can tell the parts that
 * came from this lease apart from the template's own wording.
 *
 * The PDF sets everything between them in bold: the names, the identity and
 * account numbers, the address, the amounts and the dates — the details a person
 * checks before signing, and the only parts of the page that differ from every
 * other agreement made from the same template.
 *
 * Device control characters, chosen because they cannot occur in a lease: a
 * template containing one would have to have been authored with a hex editor.
 * `stripValueMarks` removes them for anything that is not the PDF.
 */
export const VALUE_MARK_START = '\u0011';
export const VALUE_MARK_END = '\u0012';

/** Plain text, with the marks removed. Safe on text that has none. */
export function stripValueMarks(text: string): string {
  return text.split(VALUE_MARK_START).join('').split(VALUE_MARK_END).join('');
}

/**
 * Substitutes placeholders, and reports rather than hides what it could not
 * fill. An unresolved placeholder is left visibly in the text as its own name
 * so a proofreader sees it; it is never replaced with an empty string.
 *
 * `markValues` wraps each substitution — including the `[name]` left behind for
 * one that could not be filled, which is exactly the thing a proofreader most
 * needs to see.
 */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
  options: { markValues?: boolean } = {},
): RenderResult {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  // A template that already contains a mark would let its author forge emphasis
  // inside the merged values. There is no legitimate reason for one to be there.
  const source = options.markValues ? stripValueMarks(body) : body;
  const mark = (value: string): string =>
    options.markValues ? `${VALUE_MARK_START}${value}${VALUE_MARK_END}` : value;

  const text = source.replace(PLACEHOLDER, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!FIELD_BY_KEY.has(key)) {
      unknown.add(key);
      return whole;
    }
    const value = values[key];
    if (value === undefined || value.trim() === '') {
      missing.add(key);
      return mark(`[${key}]`);
    }
    return mark(value);
  });
  return { text, missing: [...missing].sort(), unknown: [...unknown].sort() };
}

/** Placeholders a template uses, for showing an operator what it needs. */
export function templatePlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!.toLowerCase()))].sort();
}

/** Dates in an agreement read the same as dates everywhere else: dd/mm/yyyy. */
export const formatLeaseDate = formatDayMonthYear;

const yesNo = (v: boolean | null | undefined): string => (v === null || v === undefined ? '' : v ? 'Yes' : 'No');
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  debit_order: 'Debit order', bank_deposit: 'Bank deposit', eft: 'Electronic funds transfer', other: 'Other',
};

export interface MergeContext {
  values: Record<string, string>;
  /** Masked copies, safe to persist in the generation snapshot. */
  redacted: Record<string, string>;
  leaseReference: string;
  currencyCode: string;
}

/**
 * Collects every value a template could ask for.
 *
 * Sealed identity and bank numbers are opened here and only here. The caller
 * must already have checked `lease.agreement.generate`; RLS enforces that on the
 * rows, and the command layer writes the audit event.
 */
export async function buildMergeContext(
  tx: Sql,
  organisationId: string,
  leaseId: string,
): Promise<MergeContext> {
  const [lease] = await tx<{
    id: string; reference: string; currency_code: string; start_date: string; end_date: string | null;
    rent_minor: string; deposit_required_minor: string | null; escalation_percent: string | null;
    notice_days: number | null; organisation_name: string;
    unit_code: string | null; building_name: string | null;
    address_line1: string | null; address_line2: string | null; suburb: string | null;
    city: string | null; province: string | null; postal_code: string | null;
  }[]>`
    select l.id, l.reference, l.currency_code, l.start_date::text, l.end_date::text,
           l.rent_minor::text, l.deposit_required_minor::text, l.escalation_percent::text,
           l.notice_days, o.name as organisation_name,
           u.code as unit_code, b.name as building_name,
           p.address_line1, p.address_line2, p.suburb, p.city, p.province, p.postal_code
      from leases l
      join organisations o on o.id = l.organisation_id
      join properties p on p.id = l.property_id
      left join units u on u.id = l.unit_id
      left join buildings b on b.id = u.building_id
     where l.id = ${leaseId} and l.organisation_id = ${organisationId}
  `;
  if (!lease) throw new Error('Lease not found.');

  const [profile] = await tx<Record<string, string | null>[]>`
    select legal_name, trading_name, registration_number, vat_number,
           identity_number_cipher, physical_address, postal_address, phone,
           email::text as email, next_of_kin_name, next_of_kin_phone,
           agent_name, agent_contact, agent_registration_number, agent_practitioner,
           agent_certificate_number
      from organisation_profiles where organisation_id = ${organisationId}
  `;

  const [terms] = await tx<Record<string, string | null>[]>`
    select parking_bays, max_occupants::text, permanent_vehicles::text,
           smoking_allowed::text, pets_allowed::text, pets_detail,
           admin_fee_minor::text, credit_check_fee_minor::text, inspection_fee_minor::text,
           arrear_interest_monthly_percent::text, arrear_interest_annual_cap_percent::text,
           renewal_option_months::text, renewal_notice_months::text,
           cancellation_penalty_months::text, sales_commission_percent::text,
           payment_method::text, place_of_payment, jurisdiction_court,
           key_return_at::text, surcharge_detail, special_conditions,
           deposit_refund_days::text, defects_notice_days::text,
           maintenance_callout_fee_minor::text, early_cancellation_cap_minor::text,
           named_occupants, payment_reference, complaints_threshold::text,
           refund_account_holder, refund_bank_name, refund_branch_code,
           refund_account_number_last4
      from lease_agreement_terms where lease_id = ${leaseId}
  `;

  // Parties who sign. Guarantors and occupants are named elsewhere in an
  // agreement and are deliberately not folded into the tenant list.
  const parties = await tx<{
    resident_id: string; role: string; first_name: string; last_name: string;
    email: string | null; phone: string | null; identity_number_cipher: Buffer | null;
  }[]>`
    select lp.resident_id, lp.role::text as role, r.first_name, r.last_name,
           r.email::text as email, r.phone, r.identity_number_cipher
      from lease_parties lp
      join resident_profiles r on r.id = lp.resident_id
     where lp.lease_id = ${leaseId} and lp.organisation_id = ${organisationId}
       and lp.removed_on is null
       and lp.role in ('primary_resident', 'co_lessee')
     order by case lp.role when 'primary_resident' then 0 else 1 end, r.last_name, r.first_name
  `;

  const [bank] = await tx<{
    label: string | null; bank_name: string | null; branch_code: string | null;
    account_number_cipher: Buffer | null;
  }[]>`
    select label, bank_name, branch_code, account_number_cipher
      from bank_accounts
     where organisation_id = ${organisationId} and is_active and account_role = 'operating'
     order by verified_at nulls last, created_at
     limit 1
  `;

  const currency = lease.currency_code ?? 'ZAR';
  const money = (minor: string | null | undefined): string =>
    minor === null || minor === undefined ? '' : formatMoney(BigInt(minor), currency);

  // Opening a sealed value can fail — wrong key, altered row. That must surface
  // as a missing field on a draft, not as a crash that loses the operator's work.
  const open = (cipher: Buffer | null, context: string): string => {
    if (!cipher) return '';
    try {
      return openField(cipher, context);
    } catch {
      return '';
    }
  };

  const primary = parties[0];
  const tenantNames = parties.map((p) => `${p.first_name} ${p.last_name}`.trim());
  const tenantIds = parties.map((p) => open(p.identity_number_cipher, `resident:${p.resident_id}`)).filter(Boolean);

  const addressParts = [
    lease.unit_code ? `Unit ${lease.unit_code}` : null,
    lease.building_name,
    lease.address_line1,
    lease.address_line2,
    lease.suburb,
    lease.city,
    lease.postal_code,
  ].filter((v): v is string => Boolean(v && v.trim()));

  const months = lease.end_date
    ? Math.max(
        0,
        Math.round(
          (new Date(`${lease.end_date}T00:00:00Z`).getTime() -
            new Date(`${lease.start_date}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24 * 30.4375),
        ),
      )
    : 0;

  const landlordId = open((profile?.identity_number_cipher as unknown as Buffer) ?? null, `organisation:${organisationId}`);
  const accountNumber = open(bank?.account_number_cipher ?? null, `bank_account:${organisationId}`);

  const values: Record<string, string> = {
    'landlord.name': profile?.legal_name ?? profile?.trading_name ?? lease.organisation_name,
    'landlord.registration_number': profile?.registration_number ?? '',
    'landlord.identity_number': landlordId,
    'landlord.vat_number': profile?.vat_number ?? '',
    'landlord.physical_address': profile?.physical_address ?? '',
    'landlord.postal_address': profile?.postal_address ?? '',
    'landlord.phone': profile?.phone ?? '',
    'landlord.email': profile?.email ?? '',
    'landlord.next_of_kin_name': profile?.next_of_kin_name ?? '',
    'landlord.next_of_kin_phone': profile?.next_of_kin_phone ?? '',
    'agent.name': profile?.agent_name ?? '',
    'agent.contact': profile?.agent_contact ?? '',
    'agent.registration_number': profile?.agent_registration_number ?? '',
    'agent.practitioner': profile?.agent_practitioner ?? '',
    'agent.certificate_number': profile?.agent_certificate_number ?? '',

    'tenant.names': tenantNames.join(' and '),
    'tenant.primary_name': primary ? `${primary.first_name} ${primary.last_name}`.trim() : '',
    'tenant.primary_identity_number': primary ? open(primary.identity_number_cipher, `resident:${primary.resident_id}`) : '',
    'tenant.primary_email': primary?.email ?? '',
    'tenant.primary_phone': primary?.phone ?? '',
    'tenant.identity_numbers': tenantIds.join(', '),
    'tenant.count': String(parties.length),

    'property.unit_number': lease.unit_code ?? '',
    'property.building_name': lease.building_name ?? '',
    'property.street_address': [lease.address_line1, lease.address_line2].filter(Boolean).join(', '),
    'property.suburb': lease.suburb ?? '',
    'property.city': lease.city ?? '',
    'property.province': lease.province ?? '',
    'property.postal_code': lease.postal_code ?? '',
    'property.full_address': addressParts.join(', '),

    'term.effective_date': formatLeaseDate(lease.start_date),
    'term.termination_date': formatLeaseDate(lease.end_date),
    'term.initial_months': months ? String(months) : '',
    'term.key_return_date': formatLeaseDate(terms?.key_return_at ?? null),
    'term.deposit_refund_days': terms?.deposit_refund_days ?? '',
    'term.defects_notice_days': terms?.defects_notice_days ?? '',
    'term.renewal_option_months': terms?.renewal_option_months ?? '',
    'term.renewal_notice_months': terms?.renewal_notice_months ?? '',
    'term.notice_days': lease.notice_days === null ? '' : String(lease.notice_days),

    'money.rent': money(lease.rent_minor),
    'money.deposit': money(lease.deposit_required_minor),
    'money.admin_fee': money(terms?.admin_fee_minor),
    'money.credit_check_fee': money(terms?.credit_check_fee_minor),
    'money.inspection_fee': money(terms?.inspection_fee_minor),
    'money.escalation_percent': lease.escalation_percent ? String(Number(lease.escalation_percent)) : '',
    'money.arrear_interest_monthly': terms?.arrear_interest_monthly_percent ? String(Number(terms.arrear_interest_monthly_percent)) : '',
    'money.arrear_interest_annual_cap': terms?.arrear_interest_annual_cap_percent ? String(Number(terms.arrear_interest_annual_cap_percent)) : '',
    'money.cancellation_penalty_months': terms?.cancellation_penalty_months ? String(Number(terms.cancellation_penalty_months)) : '',
    'money.sales_commission_percent': terms?.sales_commission_percent ? String(Number(terms.sales_commission_percent)) : '',
    'money.maintenance_callout_fee': money(terms?.maintenance_callout_fee_minor),
    'money.early_cancellation_cap': money(terms?.early_cancellation_cap_minor),

    'bank.account_holder': bank?.label ?? '',
    'bank.name': bank?.bank_name ?? '',
    'bank.branch_code': bank?.branch_code ?? '',
    'bank.account_number': accountNumber,
    'bank.payment_method': terms?.payment_method ? (PAYMENT_METHOD_LABEL[terms.payment_method] ?? terms.payment_method) : '',
    'bank.place_of_payment': terms?.place_of_payment ?? '',
    'bank.payment_reference': terms?.payment_reference ?? '',

    'refund.account_holder': terms?.refund_account_holder ?? '',
    'refund.bank': terms?.refund_bank_name ?? '',
    'refund.branch_code': terms?.refund_branch_code ?? '',
    // The tenant's own account number. Only the last four digits are read here:
    // the agreement identifies the account, and nothing needs the whole number
    // to do that. Opening the sealed value is a separate, deliberate act.
    'refund.account_number': terms?.refund_account_number_last4
      ? `•••••• ${terms.refund_account_number_last4}`
      : '',

    'rules.parking_bays': terms?.parking_bays ?? '',
    'rules.max_occupants': terms?.max_occupants ?? '',
    'rules.permanent_vehicles': terms?.permanent_vehicles ?? '',
    'rules.smoking_allowed': yesNo(terms?.smoking_allowed === null || terms?.smoking_allowed === undefined ? null : terms.smoking_allowed === 'true'),
    'rules.pets_allowed': yesNo(terms?.pets_allowed === null || terms?.pets_allowed === undefined ? null : terms.pets_allowed === 'true'),
    'rules.pets_detail': terms?.pets_detail ?? '',
    'rules.surcharge': terms?.surcharge_detail ?? '',
    'rules.special_conditions': terms?.special_conditions ?? '',
    'rules.named_occupants': terms?.named_occupants ?? '',
    'rules.complaints_threshold': terms?.complaints_threshold ?? '',

    'legal.jurisdiction_court': terms?.jurisdiction_court ?? '',
    'doc.lease_reference': lease.reference,
    'doc.organisation_name': lease.organisation_name,
    'doc.generated_date': formatLeaseDate(new Date()),
  };

  // What may be written down afterwards. The full numbers exist only in the
  // generated PDF, which lives in private storage under the same authorisation
  // as every other document.
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = FIELD_BY_KEY.get(key);
    redacted[key] = field?.sensitive && value
      ? `${'•'.repeat(Math.max(0, value.replace(/\D/g, '').length - 4))}${value.replace(/\D/g, '').slice(-4)}`
      : value;
  }

  return { values, redacted, leaseReference: lease.reference, currencyCode: currency };
}
