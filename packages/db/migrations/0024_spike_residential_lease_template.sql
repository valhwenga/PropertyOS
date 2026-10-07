-- 0024_spike_residential_lease_template.sql
-- The residential lease template Spike ships with the product.
--
-- WORDING: written for PropertyOS. It is not a copy of any commercial lease
-- pack, and it is not legal advice. It is structured around South African
-- residential letting — the Rental Housing Act 50 of 1999, the Consumer
-- Protection Act 68 of 2008 where it applies, PIE for eviction and POPIA for
-- personal information — and it states plainly, in the document itself, that a
-- landlord should have it reviewed by a qualified attorney before use.
--
-- A customer copies this into their own templates and edits it there. Nothing
-- generates an agreement directly from a system template.

insert into system_lease_templates (name, layout, provenance, summary, status)
values (
  'Residential lease — South Africa',
  'inline',
  'Written for Spike PropertyOS. Not a reproduction of any third-party lease pack.',
  'A plain-language residential lease for a house, flat or cottage let to a natural person. '
  || 'Covers term, rent and escalation, deposit handling and interest, utilities, maintenance, '
  || 'breach, early cancellation under the Consumer Protection Act, and notice addresses.',
  'published'
);

insert into system_lease_template_versions (template_id, version, body, published_at)
select id, 1, $BODY$
RESIDENTIAL LEASE AGREEMENT

Reference {{doc.lease_reference}}
Prepared by {{doc.organisation_name}} on {{doc.generated_date}}

This agreement is not legal advice. Have it reviewed by a qualified attorney
before you rely on it.

1. PARTIES

1.1 The Landlord
    Name                {{landlord.name}}
    Identity or registration number  {{landlord.identity_number}}
    Physical address    {{landlord.physical_address}}
    Telephone           {{landlord.phone}}
    Email               {{landlord.email}}

1.2 The Tenant
    Name                {{tenant.primary_name}}
    Identity number     {{tenant.primary_identity_number}}
    Telephone           {{tenant.primary_phone}}
    Email               {{tenant.primary_email}}

1.3 All tenants signing this agreement are {{tenant.names}}. Where more than one
    person signs, each of them is liable for the whole of every obligation under
    this agreement, and the Landlord may recover the full amount from any one of
    them.

1.4 Managing agent, where one is appointed: {{agent.name}}, {{agent.contact}}.

2. THE PROPERTY

2.1 The Landlord lets to the Tenant the premises at {{property.full_address}}
    (unit {{property.unit_number}}, {{property.suburb}}, {{property.city}},
    {{property.province}}, {{property.postal_code}}).

2.2 The premises are let for residential purposes only. The Tenant may not run a
    business from them, or use them for any unlawful purpose.

2.3 The premises may be occupied by no more than {{rules.max_occupants}} people.
    Parking bays allocated: {{rules.parking_bays}}. Vehicles that may be kept
    permanently on the premises: {{rules.permanent_vehicles}}.

3. PERIOD

3.1 This lease begins on {{term.effective_date}} and ends on
    {{term.termination_date}}, an initial period of {{term.initial_months}}
    months.

3.2 The Tenant may renew for a further {{term.renewal_option_months}} months by
    telling the Landlord in writing at least {{term.renewal_notice_months}}
    months before the end date. The rent for the renewal period is the rent then
    payable, increased by the escalation in clause 4.3.

3.3 If the Tenant stays on after the end date with the Landlord's agreement and
    nothing else is agreed in writing, the lease continues month to month on the
    same terms, and either party may end it on {{term.notice_days}} days' written
    notice.

3.4 Keys are to be returned by {{term.key_return_date}}.

4. RENT

4.1 The rent is {{money.rent}} per month, payable in advance on or before the
    first day of each month, without deduction or set-off.

4.2 Payment is made by {{bank.payment_method}} to:
    Account holder   {{bank.account_holder}}
    Bank             {{bank.name}}
    Branch code      {{bank.branch_code}}
    Account number   {{bank.account_number}}
    Payment is only made once the funds reflect in that account. A deposit slip,
    screenshot or proof of transfer is evidence that payment was attempted; it is
    not payment.

4.3 The rent increases by {{money.escalation_percent}} on each anniversary of the
    start date.

4.4 Rent not paid when due carries interest at {{money.arrear_interest_monthly}}
    per month, capped at {{money.arrear_interest_annual_cap}} per year, calculated
    from the due date until payment is received. Interest does not excuse late
    payment and does not waive any other remedy.

4.5 Fees payable on signature, where applicable: administration
    {{money.admin_fee}}, credit check {{money.credit_check_fee}}, inspection
    {{money.inspection_fee}}.

5. DEPOSIT

5.1 The Tenant pays a deposit of {{money.deposit}} before taking occupation.

5.2 The Landlord holds the deposit in an interest-bearing account as required by
    the Rental Housing Act. Interest accrues for the Tenant's benefit at no less
    than the rate the Landlord's bank pays on a savings account.

5.3 The deposit is the Tenant's money held by the Landlord. It is not rent, it is
    not income, and the Tenant may not ask that it be applied to rent during the
    lease.

5.4 The parties must inspect the premises together before the Tenant moves in,
    and again within three days before the lease ends, and must record the
    condition in writing on both occasions.

5.5 Within seven days after the lease ends and the Tenant has vacated, the
    Landlord must refund the deposit with interest, less any amount properly owed
    for rent, charges or repair of damage beyond fair wear and tear. The Landlord
    must give the Tenant written proof of what was deducted and why.

6. UTILITIES AND CHARGES

6.1 Unless stated otherwise, the Tenant pays for water, electricity, sewerage,
    refuse and any metered service used at the premises, at the rate charged by
    the supplier, plus any surcharge of {{rules.surcharge}}.

6.2 Where a service is billed to the Landlord and recovered from the Tenant, the
    Landlord must give the Tenant a copy of the underlying account on request.

7. CONDITION, USE AND MAINTENANCE

7.1 The Tenant accepts the premises in the condition recorded at the incoming
    inspection.

7.2 The Tenant must keep the premises clean, must not damage them, and must tell
    the Landlord in writing, without delay, of anything that needs repair.

7.3 The Landlord is responsible for the structure, the roof, the plumbing, the
    electrical installation and anything that makes the premises unfit to live
    in, unless the Tenant caused the problem.

7.4 The Tenant is responsible for day-to-day upkeep, including replacing light
    bulbs, unblocking drains caused by the Tenant's use, and keeping any garden
    in the condition it was received.

7.5 The Tenant may not alter the premises, or install anything fixed to them,
    without the Landlord's written permission.

7.6 Smoking inside the premises: {{rules.smoking_allowed}}.
    Pets: {{rules.pets_allowed}}. {{rules.pets_detail}}

8. ACCESS

8.1 The Landlord may enter the premises at a reasonable time, having given the
    Tenant at least 24 hours' notice, to inspect, repair, or show the premises to
    a prospective tenant or buyer.

8.2 In an emergency the Landlord may enter without notice, and must tell the
    Tenant as soon as possible afterwards what was done and why.

9. SUBLETTING

The Tenant may not sublet the premises, or give occupation to anyone else,
without the Landlord's written permission.

10. INSURANCE

10.1 The Landlord insures the building. That insurance does not cover the
     Tenant's belongings.

10.2 The Tenant is responsible for insuring their own belongings and for any
     liability arising from their use of the premises.

11. BREACH

11.1 If the Tenant fails to pay rent or any other amount when due, or breaches any
     other term, the Landlord must give written notice calling on the Tenant to
     put it right within 20 business days.

11.2 If the Tenant does not put it right within that period, the Landlord may
     cancel this lease and claim damages, and may take steps to recover
     possession.

11.3 The Landlord may only evict the Tenant by order of a court, obtained under
     the Prevention of Illegal Eviction from and Unlawful Occupation of Land Act.
     The Landlord may not lock the Tenant out, remove their belongings, or cut off
     water or electricity to force them to leave.

12. EARLY CANCELLATION BY THE TENANT

12.1 Where the Consumer Protection Act applies to this lease, the Tenant may
     cancel it at any time by giving 20 business days' written notice.

12.2 The Landlord may then charge a reasonable cancellation penalty, which the
     parties agree will not exceed {{money.cancellation_penalty_months}} months'
     rent, and may recover any amount already owed.

13. NOTICES AND ADDRESSES

13.1 Each party chooses the address given in clause 1 as the address at which
     legal documents may be served.

13.2 A notice sent by email to the address in clause 1 is treated as received on
     the next business day, unless the sender is told it did not arrive.

13.3 A party who changes their address must tell the other in writing within
     seven days.

14. PERSONAL INFORMATION

14.1 The Landlord processes the Tenant's personal information to administer this
     lease, to recover amounts owed, and to meet legal obligations.

14.2 The Landlord may share that information with a credit bureau, a managing
     agent, a municipality or a service provider where it is necessary for those
     purposes, and must keep it secure and no longer than is necessary.

15. SPECIAL CONDITIONS

{{rules.special_conditions}}

16. GENERAL

16.1 This document is the whole agreement between the parties. No change to it
     binds either party unless it is in writing and signed by both.

16.2 If a court finds any clause unenforceable, the rest of the agreement
     continues to apply.

16.3 The parties consent to the jurisdiction of the
     {{legal.jurisdiction_court}} for any proceedings arising from this lease.

SIGNED BY THE PARTIES


Landlord: ............................................
{{landlord.name}}
Date: ..................  Place: ..................


Tenant: ..............................................
{{tenant.primary_name}}
Identity number {{tenant.primary_identity_number}}
Date: ..................  Place: ..................


Witness 1: ...........................................
Witness 2: ...........................................
$BODY$, now()
from system_lease_templates
where name = 'Residential lease — South Africa';
