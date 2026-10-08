# Lease templates

How to write a lease template PropertyOS can fill in.

## The format

A template is **plain text**. No Word file, no PDF, no markup — paste the
wording in as text and PropertyOS lays it out when it generates the PDF.

Wherever a value should come from the lease, the parties or the property, write
a placeholder in double braces:

```
The rent is {{money.rent}} per month, payable on or before the first day of
each month to {{bank.account_holder}}, account {{bank.account_number}}.
```

Anything that is not a placeholder is reproduced exactly as you typed it.

### What happens to a placeholder with no value

It prints as `[money.rent]` in square brackets, and the generated agreement is
listed as having missing fields. It is **never** silently blank and never
invented. A blank in a signed lease is a dispute; a visible `[money.rent]` is a
question someone asks before signing.

A placeholder that is not a real field behaves the same way, so a typo shows up
rather than disappearing.

## Where templates live

| Who | Where | What they can do |
| --- | --- | --- |
| A landlord | Settings → Lease templates | Write their own, or copy one of Spike's and edit it |
| Spike | Platform → Lease templates | Publish templates every customer can copy |

A customer **copies** a Spike template rather than using it live. From that
moment the wording is theirs. Spike publishing a correction later never changes
a template a landlord has adopted, and never changes an agreement already
generated — on a signed lease, silent edits would be indefensible.

A published version is immutable. Correcting wording means publishing a new
version, so it stays clear which text was in force when an agreement was made.

## Before you publish someone else's wording

If a lease pack is licensed to you, check whether the licence covers *adapting*
it and, for Spike-published templates, whether it covers *redistributing* it to
customers. A licence to use a document is not automatically a licence to pass it
on. The "where this wording came from" field is required for exactly this
reason: a landlord adopting wording should be able to see its provenance.

Nothing in PropertyOS checks this for you.

## The fields

Generated from the catalogue in `packages/domain/src/lease-agreements.ts`. A
test fails if this list and the code drift apart.

### Landlord

| Placeholder | What it fills |
| --- | --- |
| `{{landlord.name}}` | Landlord name |
| `{{landlord.registration_number}}` | Registration number |
| `{{landlord.identity_number}}` | Landlord identity number |
| `{{landlord.vat_number}}` | VAT number |
| `{{landlord.physical_address}}` | Physical address |
| `{{landlord.postal_address}}` | Postal address |
| `{{landlord.phone}}` | Telephone |
| `{{landlord.email}}` | Email |
| `{{landlord.next_of_kin_name}}` | Next of kin |
| `{{landlord.next_of_kin_phone}}` | Next of kin telephone |
| `{{agent.name}}` | Managing agent |
| `{{agent.contact}}` | Agent contact |
| `{{agent.registration_number}}` | Agency registration number |
| `{{agent.practitioner}}` | Responsible practitioner |
| `{{agent.certificate_number}}` | Fidelity Fund certificate |

### Tenant

| Placeholder | What it fills |
| --- | --- |
| `{{tenant.names}}` | All tenant names |
| `{{tenant.primary_name}}` | Primary tenant |
| `{{tenant.primary_identity_number}}` | Primary tenant identity number |
| `{{tenant.primary_email}}` | Primary tenant email |
| `{{tenant.primary_phone}}` | Primary tenant telephone |
| `{{tenant.identity_numbers}}` | All tenant identity numbers |
| `{{tenant.count}}` | Number of tenants |

### Premises

| Placeholder | What it fills |
| --- | --- |
| `{{property.unit_number}}` | Unit / door number |
| `{{property.building_name}}` | Complex / building |
| `{{property.street_address}}` | Street address |
| `{{property.suburb}}` | Suburb |
| `{{property.city}}` | City |
| `{{property.province}}` | Province |
| `{{property.postal_code}}` | Postal code |
| `{{property.full_address}}` | Full address, one line |

### Term

| Placeholder | What it fills |
| --- | --- |
| `{{term.effective_date}}` | Commencement date |
| `{{term.termination_date}}` | Termination date |
| `{{term.initial_months}}` | Initial period, months |
| `{{term.key_return_date}}` | Key return date |
| `{{term.deposit_refund_days}}` | Deposit refund, days |
| `{{term.defects_notice_days}}` | Defects notice, days |
| `{{term.renewal_option_months}}` | Renewal option, months |
| `{{term.renewal_notice_months}}` | Renewal notice, months |
| `{{term.notice_days}}` | Notice period, days |

### Money

| Placeholder | What it fills |
| --- | --- |
| `{{money.rent}}` | Monthly rental |
| `{{money.deposit}}` | Deposit |
| `{{money.admin_fee}}` | Administration fee |
| `{{money.credit_check_fee}}` | Credit check fee |
| `{{money.inspection_fee}}` | Inspection fee |
| `{{money.escalation_percent}}` | Escalation |
| `{{money.arrear_interest_monthly}}` | Arrear interest, monthly % |
| `{{money.arrear_interest_annual_cap}}` | Arrear interest cap, annual % |
| `{{money.cancellation_penalty_months}}` | Cancellation penalty, months |
| `{{money.sales_commission_percent}}` | Sales commission % |
| `{{money.maintenance_callout_fee}}` | Maintenance call-out fee |
| `{{money.early_cancellation_cap}}` | Early cancellation charge cap |

### Banking

| Placeholder | What it fills |
| --- | --- |
| `{{bank.account_holder}}` | Account holder |
| `{{bank.name}}` | Bank |
| `{{bank.branch_code}}` | Branch code |
| `{{bank.account_number}}` | Account number |
| `{{bank.payment_method}}` | Payment method |
| `{{bank.place_of_payment}}` | Place of payment |
| `{{bank.payment_reference}}` | Payment reference |
| `{{refund.account_holder}}` | Deposit refund account holder |
| `{{refund.bank}}` | Deposit refund bank |
| `{{refund.branch_code}}` | Deposit refund branch code |
| `{{refund.account_number}}` | Deposit refund account number — masked to the last four digits |

### Rules

| Placeholder | What it fills |
| --- | --- |
| `{{rules.parking_bays}}` | Parking bay(s) |
| `{{rules.max_occupants}}` | Maximum occupants |
| `{{rules.permanent_vehicles}}` | Permanent vehicles |
| `{{rules.smoking_allowed}}` | Smoking allowed |
| `{{rules.pets_allowed}}` | Pets allowed |
| `{{rules.pets_detail}}` | Pet details |
| `{{rules.surcharge}}` | Surcharge |
| `{{rules.special_conditions}}` | Special conditions |
| `{{rules.named_occupants}}` | Named occupants and relationship to tenant |
| `{{rules.complaints_threshold}}` | Substantiated complaints that count as a material breach |

### Legal

| Placeholder | What it fills |
| --- | --- |
| `{{legal.jurisdiction_court}}` | Magistrate's court |

### Document

| Placeholder | What it fills |
| --- | --- |
| `{{doc.lease_reference}}` | Lease reference |
| `{{doc.organisation_name}}` | Organisation |
| `{{doc.generated_date}}` | Date generated |
