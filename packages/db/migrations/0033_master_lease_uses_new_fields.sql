-- 0033_master_lease_uses_new_fields.sql
-- The master lease, with every blank that had somewhere to live now filled from
-- the data.
--
-- 0032 gave these fields columns, a form and a place in the merge catalogue.
-- This publishes the version of the lease that actually uses them: the agency's
-- registration, practitioner and Fidelity Fund certificate; the named occupants;
-- the payment reference; the deposit refund account; the maintenance call-out
-- fee; the early cancellation cap; and the two periods — how long a tenant has
-- to report defects, and how long the landlord has to return the deposit.
--
-- The refund period is a FLOOR, not a replacement. Clause 13.4 keeps the Rental
-- Housing Act's seven and fourteen days, and the agreed period applies only
-- where it is shorter: a landlord typing 45 into the schedule does not buy
-- themselves 45 days.
--
-- The deposit refund account is the tenant's, so the number is sealed and the
-- agreement shows the last four digits. That is enough to identify the account
-- and not enough to pay anyone from it.
--
-- Clause 17 of the first source document — the landlord cutting services,
-- forcing entry and removing the tenant's goods without a court order — was
-- removed on the owner's instruction of 8 October 2026 and is not in any
-- version. The drift test fails any version that brings it back.

insert into system_lease_template_versions (template_id, version, body, published_at)
select t.id,
       coalesce((select max(v.version) from system_lease_template_versions v
                  where v.template_id = t.id), 0) + 1,
       $BODY$
RESIDENTIAL LEASE AGREEMENT
South Africa

The Landlord lets the residential premises identified below to the Tenant on the terms of this agreement. The completed schedule, agreed special conditions and signed annexures form part of the agreement.

Complete all applicable blanks before signing. Write "Not applicable" where appropriate, select the stated options and initial any changes. No optional fee, rate or additional charge is agreed merely because its field appears in this form. Retain a signed copy for each party.

Lease reference {{doc.lease_reference}}, prepared by {{doc.organisation_name}} on {{doc.generated_date}}.

This agreement is not legal advice. Have it reviewed by a qualified attorney before you rely on it.

1. SCHEDULE

1.1 Landlord

    Full legal name or entity name    {{landlord.name}}
    Identity number                   {{landlord.identity_number}}
    Registration number               {{landlord.registration_number}}
    VAT number                        {{landlord.vat_number}}
    Physical address for notices      {{landlord.physical_address}}
    Postal address                    {{landlord.postal_address}}
    Telephone                         {{landlord.phone}}
    Email                             {{landlord.email}}
    Emergency contact                 {{landlord.next_of_kin_name}}
    Emergency telephone               {{landlord.next_of_kin_phone}}

1.2 Tenants

1.2.1 Every contracting tenant is listed here. Occupants who are not contracting tenants belong in item 1.5.

    All contracting tenants           {{tenant.names}}
    Number of contracting tenants     {{tenant.count}}
    Identity or passport numbers      {{tenant.identity_numbers}}

    Primary tenant                    {{tenant.primary_name}}
    Identity or passport number       {{tenant.primary_identity_number}}
    Telephone                         {{tenant.primary_phone}}
    Email                             {{tenant.primary_email}}

1.2.2 Physical notice address for each tenant in South Africa, with tenant identified:
    ______________________________________________________________________

1.3 Agent if appointed

    Business name                     {{agent.name}}
    Contact                           {{agent.contact}}
    Registration number               {{agent.registration_number}}
    Responsible practitioner          {{agent.practitioner}}
    Fidelity Fund certificate         {{agent.certificate_number}}
    Authority and duties under the written mandate:
    ______________________________________________________________________
    Mandatory disclosure form attached, where required: ____________________

1.4 Premises

    Unit or house number              {{property.unit_number}}
    Building or complex               {{property.building_name}}
    Street address                    {{property.street_address}}
    Suburb                            {{property.suburb}}
    City                              {{property.city}}
    Province                          {{property.province}}
    Postal code                       {{property.postal_code}}
    Full address                      {{property.full_address}}
    Parking bays, storage and exclusive use areas    {{rules.parking_bays}}
    Furniture, equipment and other inclusions: _____________________________
    Areas excluded from this letting: ______________________________________

1.5 Occupation and permissions

    Maximum occupants                 {{rules.max_occupants}}
    Permitted vehicles                {{rules.permanent_vehicles}}
    Smoking and vaping permitted      {{rules.smoking_allowed}}
    Pets permitted                    {{rules.pets_allowed}}
    Pet number, type and conditions   {{rules.pets_detail}}
    Named occupants and relationship  {{rules.named_occupants}}
    Permitted work from home or other agreed use: __________________________
    Garden, pool or other routine care allocated to Tenant: ________________
    Optional forwarding or alternative address: ____________________________

1.6 Term and handover

    Commencement date                 {{term.effective_date}}
    Fixed term end date               {{term.termination_date}}
    Initial term in months            {{term.initial_months}}
    Key return date and time          {{term.key_return_date}}
    Renewal option, months            {{term.renewal_option_months}}
    Renewal notice by Tenant, months  {{term.renewal_notice_months}}
    Notice period, days               {{term.notice_days}}
    Deposit refund, days              {{term.deposit_refund_days}}
    Defects notice, days              {{term.defects_notice_days}}
    Occupation date and time: ______________________________________________
    If a term longer than 24 months is agreed, demonstrable financial benefit to Tenant:
    ______________________________________________________________________

1.7 Rent and security deposit

    Monthly rent                      {{money.rent}}
    Due day of each month             1st
    Payment method                    {{bank.payment_method}}
    Annual escalation                 {{money.escalation_percent}}
    Deposit                           {{money.deposit}}
    Arrears interest, monthly         {{money.arrear_interest_monthly}}
    Arrears interest, annual cap      {{money.arrear_interest_annual_cap}}
    First or partial month rent: R _________________________________________
    First escalation date and interval thereafter: _________________________
    Deposit payment deadline: ______________________________________________
    Deposit holder and capacity: ___________________________________________
    Agreed deposit increase formula and notice period, if any: _____________

1.8 Agreed additional costs

    Lease administration              {{money.admin_fee}}
    Screening or credit check         {{money.credit_check_fee}}
    Inspection                        {{money.inspection_fee}}
    Cancellation penalty, months      {{money.cancellation_penalty_months}}
    Surcharge on recovered services   {{rules.surcharge}}
    Maintenance call-out              {{money.maintenance_callout_fee}}
    Early cancellation charge cap     {{money.early_cancellation_cap}}
    Parking, if separately charged: R ______________ per ___________________
    Other fee, service and amount or calculation: __________________________
    Tax treatment of taxable services, if relevant: ________________________
    Utility allocation and billing details: complete Annexure B.

1.9 Payment and refund accounts

    Rent account holder               {{bank.account_holder}}
    Bank                              {{bank.name}}
    Account number                    {{bank.account_number}}
    Branch code                       {{bank.branch_code}}
    Place of payment                  {{bank.place_of_payment}}
    Payment reference                 {{bank.payment_reference}}

    Deposit refund account holder     {{refund.account_holder}}
    Deposit refund bank               {{refund.bank}}
    Deposit refund branch code        {{refund.branch_code}}
    Deposit refund account number     {{refund.account_number}}

1.10 Special conditions and attachments

    Special conditions                {{rules.special_conditions}}
    Attached signed addendum reference: ____________________________________
    Attachments included and initialled by both parties: ___________________

    Available annexures: A inspections and inventory; B utilities and additional arrangements; C optional limited suretyship. Attach applicable house rules and any legally required property disclosure form. Special conditions cannot override mandatory law.

2. MEANINGS OF KEY TERMS

2.1 "Landlord" and "Tenant" mean the persons named in items 1.1 and 1.2. An agent may act only within the authority given by the person represented. "Parties" means the Landlord and Tenant together.

2.2 "Premises" means the dwelling and included areas described in item 1.4. "Rent" and "Deposit" mean the completed amounts in item 1.7. "Fixed term" means the period in item 1.6 or a later fixed period agreed in writing.

2.3 "Business day" excludes Saturdays, Sundays and South African public holidays. Other references to days mean calendar days. "Writing" includes a readable electronic record that can be retained.

2.4 "Fair wear and tear" means deterioration from reasonable everyday use, ageing and exposure over time. It excludes damage caused by misuse or a failure to take reasonable care.

2.5 "Material breach" means a failure serious enough to justify cancellation under the circumstances and applicable law. A minor mistake or every rule infringement is not automatically material.

2.6 "CPA" means the Consumer Protection Act 68 of 2008. "Rental Housing Act" means the Rental Housing Act 50 of 1999. "POPIA" means the Protection of Personal Information Act 4 of 2013. "PIE" means the Prevention of Illegal Eviction from and Unlawful Occupation of Land Act 19 of 1998. References include applicable amendments and regulations in force.

3. READING THIS AGREEMENT

3.1 The schedule records the particulars of this letting. Clause numbers refer to the main terms and item numbers refer to the schedule. Annexures apply only to the extent completed and agreed.

3.2 Read the agreement as a whole using the ordinary meaning of its words. Headings help navigation. Singular terms include the plural where appropriate. Mandatory law prevails over inconsistent terms or house rules.

3.3 For contractual day periods, do not count the day notice is received; count the final day. Statutory periods must be calculated as the relevant law requires. Times are South African Standard Time.

3.4 No provision excludes a right that the law protects against waiver. Accrued payment obligations, deposit accounting and other provisions needed to settle the tenancy continue after it ends.

4. GRANT OF THE LEASE

4.1 The Landlord gives the Tenant residential occupation and reasonable enjoyment of the Premises for the agreed rent. The Landlord confirms authority to let the Premises and will not unlawfully interfere with occupation.

4.2 The Tenant accepts the letting subject to the terms completed and signed by the parties. Signing an inspection record does not release the Landlord from an obligation to provide legally compliant and habitable accommodation.

4.3 The Premises are let subject to the conditions contained in the title deed, and subject to the provisions, if any, of the town planning scheme, the regulations of the local authority, and the laws, ordinances or regulations of other authorities which may apply. The Landlord must disclose any such condition that materially restricts the Tenant's use of the Premises.

5. TERM AND DELIVERY OF OCCUPATION

5.1 The lease starts on the commencement date in item 1.6 and runs for the stated fixed term, subject to lawful earlier termination and clauses 6 and 7. A deposit payment deadline does not silently change these dates or make the agreement retrospectively invalid.

5.2 Where CPA fixed term limits apply, a period exceeding 24 months requires the Tenant's express agreement and a demonstrable financial benefit recorded in item 1.6.

5.3 If the Landlord cannot give occupation when agreed, the parties must promptly address the delay. Rent is not due for a period in which the Landlord fails to make the Premises available, unless that failure is attributable to the Tenant. The Tenant retains lawful remedies for a material delay.

6. CONTINUATION AND RENEWAL

6.1 Where section 14 of the CPA applies, expiry of the fixed term results in a monthly tenancy unless the Tenant directs that the lease end on expiry or expressly agrees to another fixed term. Only lawful changes properly notified under clause 7 may apply.

6.2 Where section 14 does not apply, the fixed term ends on its stated date unless the parties agree otherwise. Continued occupation with the Landlord's express or implied consent creates a periodic tenancy as provided by the Rental Housing Act.

6.3 A new fixed term must be recorded in a signed renewal identifying its dates and any agreed changes. No failure to sign a proposed renewal creates a new fixed term.

6.4 Either party may end a monthly tenancy on at least one month's written notice, subject to any longer mandatory protection and lawful grounds and procedures. Rent and other obligations continue until termination.

6.5 In addition to the rights above, the Tenant has an option to renew this lease for a further {{term.renewal_option_months}} months, exercisable in writing to the Landlord not less than {{term.renewal_notice_months}} months before the fixed term end date. Exercising this option does not waive any right under clause 6 or 7.

7. NOTICE BEFORE FIXED TERM EXPIRY

7.1 Where section 14 of the CPA applies, the Landlord must give written or recordable notice between 40 and 80 business days before expiry. It must state the expiry date, proposed material changes and the Tenant's options to end, continue monthly or agree a further fixed term.

7.2 The Tenant should communicate the chosen option promptly. No contractual advance deadline removes the right to direct termination on the expiry date without an early cancellation charge. Amounts already due remain payable.

7.3 Where section 14 does not apply, the parties should discuss renewal before expiry. A notice of proposed terms is not itself acceptance of those terms.

8. PERMITTED RESIDENTIAL USE

8.1 The Premises may be used as a home by the authorised occupants. Business activities requiring customer access, signage, changes to the building or regulatory approval require prior written consent and all necessary permissions.

8.2 The Tenant must not sublet, transfer the tenancy, offer short stays or give another person independent possession without the Landlord's prior written consent. Consent will be considered reasonably and subject to applicable law.

8.3 The Tenant must not cede, pledge or renounce the Tenant's rights under this lease in favour of another person without the Landlord's prior written consent.

9. HOUSE AND COMMUNITY RULES

9.1 The Landlord must supply applicable house, body corporate or association rules. The Tenant must follow lawful rules and reasonable amendments supplied in writing, and bring relevant requirements to occupants' attention.

9.2 Rules cannot override legislation or permit unfair interference with occupation. Any proposed fine passed to the Tenant must be lawful, supported by evidence, attributable to the Tenant's responsibility and open to challenge. Clause 23 governs breach.

10. RENT AND PAYMENT

10.1 The Tenant must pay the rent in advance on the agreed due day by the selected method to the nominated account, free of exchange and without deduction, quoting the reference {{bank.payment_reference}} so the payment can be identified. The parties must record any first or final partial month calculation in writing. A separate debit order mandate is required before debits may be initiated.

10.2 The recipient must give a dated receipt identifying the Premises, amount, payment purpose and relevant period. An agent receiving payment must account to the Landlord. Account changes must be notified in writing and independently verified through known contact details.

10.3 Escalation applies only on the dates and according to the rate or formula completed in item 1.7, subject to applicable law. A blank escalation field authorises no automatic increase. Rates or levy increases do not create an additional unilateral rent increase.

10.4 If a lawful interest rate is completed in item 1.7, simple interest may accrue on overdue amounts from their actual due dates, subject to all applicable limits and required notices, including the in duplum rule. No interest rate is created by an uncompleted field, and interest is not capitalised.

10.5 A deposit slip, screenshot, reference number or other proof of payment is not payment. The Tenant's account is credited when the money reaches the nominated account, and an amount remains outstanding until it does. Sending proof promptly helps identify a payment and is encouraged, but it does not reduce the balance owing.

10.6 The Tenant must not treat the Deposit as the last month's rent. A payment dispute should be raised promptly and undisputed amounts paid when due. This does not waive any lawful right to remission, set off or relief from a tribunal or court.

11. UTILITIES AND SERVICE PROVIDERS

11.1 Annexure B must identify each service, the responsible party, the charging basis and payment deadline. The Tenant is responsible only for agreed lawful charges attributable to the tenancy and services independently ordered by the Tenant.

11.2 The Landlord must provide supporting bills, tariffs and meter readings for amounts recharged. Shared or estimated charges require a disclosed, reasonable allocation and reconciliation when actual data becomes available. No undisclosed markup is allowed.

11.3 The parties must record opening and closing readings and cooperate in obtaining accurate bills. Liability follows the period of actual responsibility; a late bill does not transfer a former occupier's debt to the Tenant.

11.4 The Landlord remains responsible to the relevant body for owner rates and levies. Any lawful agreed reimbursement by the Tenant must be expressly described in Annexure B. The Landlord must not disconnect services to force payment or departure.

11.5 For external outages, each party must take reasonable steps within its control to reduce harm. The Landlord must pursue restoration where responsible. A generator, inverter or other supply may be installed only with written consent and required safety approvals.

12. ADDITIONAL FEES AND CHARGES

12.1 Only fees expressly completed and agreed in item 1.8 or Annexure B may be charged, and only if lawful, reasonable and supported by the relevant service and expenditure. Where the law requires proof of actual expenditure, it must be supplied.

12.2 The Landlord or agent must issue an itemised invoice with the agreed due date. A renewal, credit check or maintenance attendance does not automatically create a further fee. A screening fee requires a lawful screening process. Where a maintenance call-out fee of {{money.maintenance_callout_fee}} is recorded in item 1.8, it is payable only for an attendance the Tenant requested and that was not the Landlord's responsibility under clause 15.

12.3 No taxable service may attract tax unless lawfully chargeable and properly disclosed. Residential rent must not be treated as taxable merely because a party has a tax registration number.

13. SECURITY DEPOSIT

13.1 The Tenant must pay the agreed Deposit by the recorded deadline. The Landlord must safeguard it in an interest-bearing account and credit interest at no less than the applicable savings account rate. Proof of interest must be provided on request. An authorised practitioner holding it must comply with applicable trust money law.

13.2 The Deposit remains security for the Tenant's obligations. No automatic forfeiture or routine spending during the tenancy is authorised. An increase requires the formula and notice period agreed in item 1.7 or a later lawful written agreement.

13.3 At the end of the tenancy, only sums lawfully due may be deducted, including proven arrears and reasonable costs of tenant caused damage or lost keys. Fair wear and tear, pre-existing defects and betterment must not be charged. Supply an itemised reconciliation and make supporting receipts available.

13.4 If nothing is owed, refund the Deposit and accrued interest within seven days after expiry. Where lawful deductions follow the ordinary inspection process, pay the remaining balance within 14 days after restoration of the Premises to the Landlord. Where item 1.7 records a shorter period of {{term.deposit_refund_days}} days, that shorter period applies. A longer agreed period does not displace the deadline the Rental Housing Act sets.

13.5 If the Tenant fails to respond to the requested outgoing inspection, the Landlord must inspect within seven days after expiry and refund the remaining Deposit and interest within 21 days after expiry, subject to the Rental Housing Act. Clause 14 also applies.

13.6 Where a utility or municipal account for the period of the tenancy is billed in arrears and has not yet been received, the Landlord may retain only a reasonable estimated amount for that account, must say so in the reconciliation, and must pay the balance as soon as the actual bill is available. The outstanding account is not a reason to withhold the whole Deposit.

13.7 The Deposit and its interest are refunded to the account recorded in item 1.9, held by {{refund.account_holder}} at {{refund.bank}}, unless the Tenant gives different written details before the refund is made.

13.8 A change of deposit holder requires lawful handling, written notice and a full statement of the principal and interest transferred. It does not reduce the Tenant's rights. The Tenant may claim an unpaid refund through the appropriate forum.

14. INCOMING AND OUTGOING INSPECTIONS

14.1 Before occupation, the parties must jointly inspect the Premises and complete Annexure A or a signed equivalent. Record defects, condition, inventory, readings and keys. Each party must receive the record and referenced photographs.

14.2 The record must identify any repairs promised and their completion dates. Report hidden or later discovered defects promptly in writing; discovery after occupation is not itself proof that the Tenant caused them.

14.3 The parties must arrange a joint outgoing inspection at a mutually convenient time within the three days before expiry. Compare the condition with the incoming record and allow for fair wear and tear. Record disagreements without forcing either party to admit liability.

14.4 If the Tenant does not respond to the Landlord's request, the statutory procedure and deadlines in clause 13.5 apply. Keep proof of the invitation and findings. Failure by the Landlord to carry out the required joint inspections has the consequences prescribed by the Rental Housing Act, including loss of damage claims and refund of the full Deposit and interest where that Act requires it.

14.5 The Tenant must return all keys, remotes and access devices at handover. A proven lawful amount exceeding the Deposit may be claimed separately; a contested deduction remains open to challenge.

14.6 If, on taking occupation, the Tenant finds that any light fitting, key, lock, door, window, basin, tap, sanitary fitting, drain, appliance or other fixture is not in proper working order, the Tenant should give the Landlord written notice within {{term.defects_notice_days}} days of taking occupation. Such a notice records the state of repair at occupation. Failing to give it does not create an admission that the Tenant caused a defect, and does not relieve the Landlord of any obligation under clause 15 or of a duty imposed by law.

15. MAINTENANCE AND REPAIRS

15.1 The Landlord must maintain structural elements and installations for which an owner is responsible and address defects affecting safety or habitability within a reasonable period appropriate to their urgency. Age related failures and fair wear and tear are the Landlord's responsibility unless the law permits a specific different allocation.

15.2 The Tenant must keep the Premises reasonably clean, use installations carefully, replace ordinary consumables such as light bulbs, keep drains and sewerage pipes free of blockage caused by use, and carry out the routine garden or pool care expressly allocated in item 1.5. Electrical fittings, unsafe roof work and structural repairs are not ordinary consumables or routine tenant duties.

15.3 The Tenant is responsible for reasonable repair costs of damage caused by the Tenant or persons for whom the Tenant is legally responsible. The Landlord remains responsible for pre-existing defects and failures not attributable to them.

15.4 Report leaks, unsafe conditions, pests and breakdowns promptly. A party who delays reporting is liable only for additional loss legally attributable to that delay. Pre-existing or structural pest problems fall to the Landlord; infestations caused by the Tenant's failure to keep reasonable cleanliness fall to the Tenant.

15.5 Before arranging non-urgent repairs at the other party's cost, give written details and a reasonable opportunity to act. For an immediate threat, take proportionate protective steps and notify the other party as soon as possible. Keep invoices and evidence; reimbursement depends on responsibility and applicable law.

15.6 The Tenant must not cut, damage or remove any tree, shrub or established planting without the Landlord's written consent.

16. ACCESS AND PRIVACY

16.1 The Landlord, authorised agent and contractors may enter for a legitimate inspection, repair or other agreed purpose after reasonable notice and at a reasonable agreed time. The Tenant must cooperate with reasonable arrangements and may be present.

16.2 Entry without prior agreement is limited to a genuine emergency or other lawful authority. Efforts must be made to contact the Tenant and subsequent notice must explain the entry. Keeping a spare key does not give a general right of access.

16.3 Work must be carried out with reasonable care, security and minimum disruption. The Landlord must respect the Tenant's privacy and avoid unnecessary inspection of personal belongings.

17. CARE AND RESPONSIBILITIES OF THE TENANT

17.1 The Tenant must keep the home hygienic, dispose of waste appropriately, prevent avoidable blockages and use plumbing, appliances, locks and other equipment for their intended purposes. The Tenant must notify the Landlord of damage or missing items.

17.2 The Tenant must respect neighbours, avoid unlawful activity and unreasonable noise, and comply with lawful occupancy, parking, fire and safety requirements. Vehicle and occupant limits are those completed in item 1.5.

17.3 Smoking, vaping and pets are governed by item 1.5 and lawful community rules. Any necessary disability accommodation must be considered as the law requires. The Tenant must prevent related nuisance and repair attributable damage.

17.4 Painting, drilling, fixtures, structural changes and alterations to electrical, gas or plumbing systems require prior written consent where they change or may damage the Premises. Consent must state approvals, qualified contractor requirements and responsibility for removal or reinstatement.

17.5 Do not store hazardous materials or use unsafe equipment. Ordinary domestic items must be stored and used safely. Notify the Landlord promptly of necessary lock changes and agree secure emergency access without giving unrestricted entry rights.

17.6 On departure, remove personal possessions and refuse, clean the Premises to a reasonable standard and return the inventory in its incoming condition allowing for fair wear and tear. Professional cleaning may be charged only where reasonably necessary to remedy an actual shortfall and lawfully recoverable.

17.7 No improvement automatically earns compensation. Before work begins, record whether it must remain, may be removed or must be reinstated. Nothing permits the Landlord to take the Tenant's unrelated belongings.

17.8 Where that record is not made, an improvement of a structural or permanent nature made with consent remains with the Premises at the end of the lease and the Tenant has no claim for compensation, unless the parties agreed otherwise in writing. The Landlord may instead require the Tenant to remove it and make good the resulting damage at the Tenant's cost, provided the Landlord says so in writing a reasonable time before the end of the lease.

18. VISITORS AND OTHER OCCUPANTS

18.1 The Tenant must inform visitors and occupants of relevant rules and take reasonable steps to stop known nuisance or damage. Visitors must use designated access and parking arrangements.

18.2 The Tenant is liable for visitors' conduct only to the extent supported by this agreement and law. Ordinary visits are permitted; a change in permanent occupation must be discussed and authorised where required.

19. MULTIPLE TENANTS

19.1 Each person signing as a Tenant accepts responsibility for the full rent and other tenant obligations, jointly and severally. This means the Landlord may recover the whole lawful amount from any one of them, but may not recover the same debt twice.

19.2 A tenant's departure or a private arrangement between tenants does not release that tenant without written agreement from the Landlord. Any lawful claim for contribution between tenants remains available. Notices affecting all tenants must be addressed to each of them.

20. LOSS, DAMAGE, INSURANCE AND INTERRUPTED OCCUPATION

20.1 Each party remains responsible for loss for which it is legally liable, including loss caused by negligent or intentional conduct. No term excuses fraud, gross negligence or any liability the law prohibits excluding.

20.2 The Landlord must maintain appropriate house owner's comprehensive cover on the Premises. The Tenant is responsible for insuring the Tenant's own movable contents, valuables and personal liability. The Landlord's insurance is not a guarantee of cover for the Tenant's property.

20.3 If the Tenant does, or permits, anything that increases the Landlord's house owner's premium, the Tenant must pay the amount of the increase on demand, against proof of the increase and its cause.

20.4 If a fire, disaster or other event makes the Premises wholly or partly unusable, the parties must promptly assess safety, repairs and the extent of lawful rent remission. If performance becomes impossible or the interruption justifies cancellation under law, either party may exercise the remedy available and prepaid sums must be reconciled.

20.5 Partial destruction does not by itself end this lease. The Tenant may use the undamaged portion at a proportionate rent, and during any rebuilding is liable only for a rent proportionate to the beneficial occupation actually available.

20.6 On total destruction, the Tenant is not liable for rent until beneficial occupation is restored. If the Landlord elects to rebuild and occupation resumes, the lease continues and its duration is not extended by the period of deprivation.

20.7 A Landlord who elects to rebuild must notify the Tenant in writing within 30 days of the destruction. If the Landlord does not so elect, either party may cancel this lease in writing without further notice, and prepaid amounts must be reconciled.

20.8 Nothing in clauses 20.5 to 20.7 limits a right either party has in law, including any right of the Tenant to cancel where the Premises can no longer be used for their purpose.

20.9 An outage, theft or burglary does not by itself establish either party's liability. The Landlord must address building damage within its responsibility and the Tenant must cooperate in reporting and securing the Premises. Neither party receives a blanket immunity from its own fault.

21. EARLY CANCELLATION BY THE TENANT

21.1 The Tenant may end a fixed term early by giving at least 20 business days' written notice. This right is agreed contractually even where section 14 of the CPA does not apply. Rent and agreed charges remain due up to the effective cancellation date.

21.2 The Landlord may claim only a reasonable and lawful cancellation charge, with a written calculation. Consider the notice given, remaining term, actual loss and savings, prospects of re-letting, the nature and duration of the arrangement and all prescribed factors. No minimum or automatic charge applies.

21.3 The Landlord must take reasonable steps to find a replacement and reduce loss. Replacement rent and avoided costs must be credited. No double recovery of rent, commission, advertising or other costs is permitted. The cap of {{money.early_cancellation_cap}} in item 1.8 is a ceiling, not proof that a charge up to it is reasonable.

21.4 No early cancellation charge applies when the Tenant validly cancels for the Landlord's material breach or uses a statutory right that excludes such a charge. Relocation or diplomatic transfer follows this clause unless a signed special condition grants a more favourable right.

22. TERMINATION BY THE LANDLORD

22.1 The Landlord may terminate only on a lawful basis and using the required notice and procedure. Intending to sell or occupy the home does not, under this agreement, create an unrestricted right to end a fixed term early.

22.2 A material tenant breach is dealt with under clause 23. An allegation of crime or inaccurate application information is not automatic proof of breach and does not authorise summary eviction. Urgent protective relief may be sought from a competent court.

22.3 After lawful termination the Tenant must give vacant possession, subject to any court order or statutory protection. If occupation continues, the Landlord must use lawful proceedings. Lockouts, seizure of belongings and service cutoffs are not permitted substitutes for legal process.

23. BREACH BY THE TENANT

23.1 The Landlord must give written notice explaining the breach and what is needed to remedy it. For a fixed term governed by CPA section 14, allow at least 20 business days after giving the required notice. This agreement affords the same minimum remedy period for other material breaches, unless the law requires longer.

23.2 If a material breach remains unremedied after the valid period, the Landlord may issue written cancellation or seek performance and appropriate relief. Cancellation must be proportionate and lawful. Repeated breaches that have been remedied do not automatically bypass statutory protections.

23.3 The Landlord may claim proven arrears and recoverable loss, with mitigation and credit for payments received. Urgent court relief remains available where justified; this does not authorise self-help.

23.4 While termination is disputed, the Tenant must continue paying undisputed occupation charges at the rent rate and agreed services, subject to any lawful remission or order. Acceptance of these payments does not alone resolve the dispute or establish a new lease. Final liability is subject to agreement or determination by the competent forum.

24. BREACH BY THE LANDLORD

24.1 The Tenant may notify the Landlord in writing of a breach and request a remedy. If a material breach remains unremedied after 20 business days, the Tenant may cancel in writing without an early cancellation charge and claim legally recoverable loss.

24.2 This period does not delay emergency repairs, urgent relief or any faster remedy available under law. The Tenant may seek performance, rent relief, damages or assistance from the Rental Housing Tribunal or a competent court as appropriate.

24.3 The Tenant must take reasonable steps to limit loss. Any deduction for repairs or withholding of rent must have a lawful basis or written agreement; the existence of a dispute alone does not determine the amount due.

25. UNDERSTANDING AND ACCEPTANCE

25.1 Before signing, each party must have a reasonable opportunity to read the complete agreement, ask questions and obtain advice or an explanation in a language they understand.

25.2 Particular attention is drawn to rent and fees, the Deposit, maintenance duties, multiple tenant liability, cancellation and any separate suretyship. Signature confirms agreement to the completed terms, not a waiver of protected rights or an admission that every possible legal consequence was explained.

26. RECOVERY AND LEGAL COSTS

26.1 A party may recover collection or legal costs only where allowed by law, a valid agreement or a competent forum's order. Recoverable amounts must be reasonable, supported and within applicable tariffs or limits.

26.2 There is no automatic entitlement to unlimited attorney and client costs or duplicated collection fees. Liability for litigation costs remains subject to the court or tribunal's powers.

27. COMMUNICATIONS AND FORMAL NOTICES

27.1 The physical and email addresses in the schedule are the parties' chosen notice details, and each party chooses its physical address there as its domicilium citandi et executandi for all purposes arising out of this lease. Each party must notify changes in writing. A nominated agent may receive notices only within its stated authority.

27.2 A chosen domicilium must be a physical address within the Republic of South Africa, and may not be a post box or poste restante.

27.3 Contractual notices may be delivered by hand, trackable delivery or email with evidence of receipt. A sender must retain the notice and delivery evidence. A bounced email is not effective delivery. Actual proven receipt may establish notice even if another address was used.

27.4 A notice sent by prepaid registered post is deemed received seven days after posting, unless the recipient proves it arrived later or not at all.

27.5 Court documents must be served under the applicable procedural rules. This clause does not replace a statutory service requirement or reduce a mandatory notice period. Each tenant must receive notices affecting that tenant's rights.

28. SOUTH AFRICAN LAW AND DISPUTE RESOLUTION

28.1 South African law governs this agreement, including applicable provincial rental regulations and municipal requirements. The parties should first try to resolve a written complaint promptly where practicable.

28.2 Either party may approach the Rental Housing Tribunal or another competent authority or court. The {{legal.jurisdiction_court}} may hear matters within its lawful jurisdiction; this agreement does not confer powers that the law withholds.

28.3 Nothing requires a party to give up statutory remedies or delays urgent relief. Eviction requires a court order and compliance with PIE where applicable.

29. NONCITIZEN TENANTS

29.1 Where relevant and lawfully required, a noncitizen tenant must provide valid identity and immigration documentation and remain responsible for compliance with applicable immigration requirements. Only necessary information may be collected and it must be handled under clause 31.

29.2 A change in status must be addressed lawfully; it does not authorise discrimination, confiscation of documents or summary eviction. No waiver of diplomatic or state immunity is implied. Any special arrangement needs a separate legally effective written instrument.

30. OCCUPANTS AND FORWARDING ARRANGEMENTS

30.1 Item 1.5 identifies the authorised occupants, {{rules.named_occupants}}, and the occupancy limit. Notify relevant changes promptly and obtain consent where necessary, subject to law and reasonable consideration of household circumstances.

30.2 A forwarding or possible alternative address may be provided voluntarily for contact and planning. Listing an address does not establish that accommodation is available, suitable or affordable and does not waive anyone's rights in eviction proceedings.

30.3 The Tenant must arrange an orderly handover when the tenancy lawfully ends. No acknowledgement in this agreement pre-decides a court's assessment of the circumstances of any occupant.

31. PERSONAL INFORMATION AND REGULATORY COMPLIANCE

31.1 Each party and any agent must use personal information lawfully, for defined purposes connected with screening, administering the lease, required reporting or enforcing legitimate rights. Collect only necessary information, keep it secure and retain it only as long as justified.

31.2 The responsible person must provide any required privacy notice, identify relevant recipients and explain how access, correction or complaints may be requested. Share information with contractors, advisers or prospective successors only as necessary and lawfully permitted.

31.3 Credit checks and credit bureau reporting require a lawful purpose and all applicable consent, accuracy, dispute and advance notice safeguards. This agreement is not blanket permission for unrestricted enquiries, disclosure or automatic adverse listing.

31.4 Any practitioner must comply with applicable registration, trust account and disclosure duties. The Landlord must supply mandatory property disclosures where required. A privacy complaint may be directed to the responsible party or the Information Regulator as the law permits.

32. COMPLETE AGREEMENT AND CHANGES

32.1 This document, its completed schedule and agreed annexures record the tenancy terms. An amendment or consensual cancellation must be in writing and signed by both parties, including any change to this requirement.

32.2 A valid unilateral notice under the agreement or law does not need the other party's signature. Statutory rights and remedies for misrepresentation are not excluded by the complete agreement provision.

32.3 No waiver or abandonment by either party of any right under this agreement binds that party unless it is in writing and signed by that party.

32.4 The parties must cooperate reasonably in giving effect to the agreed terms, providing required records and completing lawful handover and account reconciliation.

33. PERSONAL BELONGINGS AND ITEMS LEFT BEHIND

33.1 The Tenant retains ownership of belongings brought to the Premises. Any security right the law gives the Landlord must be enforced through the lawful process; this lease does not authorise private seizure or a general ban on moving possessions.

33.2 The Tenant must remove belongings at handover. If items remain, the Landlord must make a reasonable record, notify the Tenant and allow a reasonable collection arrangement. Items are not automatically forfeited or abandoned.

33.3 Storage, removal or disposal must follow applicable law and, where needed, legal directions. Only reasonable lawful costs may be recovered, and any proceeds must be accounted for.

33.4 South African common law gives the Landlord a tacit hypothec over movable goods brought onto the Premises, as security for rent and, where the law so allows, for other amounts owed under this lease. The Landlord may enforce that hypothec only by order of a competent court. Nothing in this clause entitles the Landlord to attach, remove, store or sell the Tenant's goods without such an order.

34. EXTENSIONS OF TIME AND CONCESSIONS

34.1 Allowing extra time or overlooking a particular failure does not by itself permanently change the agreement. Any agreed permanent change must follow clause 32. The legal effect of a party's conduct remains subject to applicable law.

35. INVALID PROVISIONS

35.1 If a term is unlawful or unenforceable, it will not be applied beyond what the law permits. The rest of the agreement continues where it can operate fairly and lawfully without that term. The parties may agree a lawful replacement consistent with the original purpose.

36. SIGNING AND COPIES

36.1 The parties may sign matching counterparts and exchange copies. Electronic signatures may be used where legally valid and sufficiently reliable to identify the signatory and approval. Any separate document with stricter signature requirements must meet them.

36.2 Each representative must have authority to bind the named party. Each party must receive the complete signed agreement and annexures. A representative does not become a personal surety merely by signing for a tenant.

37. OPTIONAL SURETYSHIP

37.1 A surety is required only if separately agreed and a properly completed suretyship is signed. Annexure C provides an optional limited undertaking. No director, trustee, member, spouse or representative is automatically a surety.

37.2 The creditor, debtor, secured obligations, maximum liability and covered period must be identified. Extensions or increased exposure require the surety's written agreement. Obtain any legally required spousal or other consent and observe signature formalities.

38. MANAGING AGENT

38.1 The agent in item 1.3 acts within the Landlord's written mandate. The Landlord remains responsible for its obligations under the lease. The Tenant must be notified promptly of a change of agent or authority.

38.2 Commission and management fees are governed by a separate mandate with the person liable to pay them. No automatic entitlement to renewal commission or deduction from the Deposit arises from this lease.

38.3 The agent named in item 1.3 acts under registration number {{agent.registration_number}}, through {{agent.practitioner}}, under Fidelity Fund certificate {{agent.certificate_number}}. An agent must provide required proof of authority and regulatory standing and properly account for money held. Required property disclosure documents must be supplied and attached. Any authorised deduction from rent must be accounted for to the Landlord.

39. VIEWINGS AND MARKETING

39.1 The Tenant must allow reasonable viewings for prospective tenants or purchasers by appointment on reasonable notice. The parties must agree workable times that respect privacy, work and family commitments. Clause 16 governs access.

39.2 Signs may be displayed only where lawful and without unreasonable interference. The Tenant must not remove, move or damage a lawfully placed sign. Marketing photographs must avoid personal documents, identifiable private information and unnecessary images of the Tenant's belongings; agree arrangements before photography.

39.3 The agent or Landlord must supervise visitors and secure the Premises afterwards. No fixed recurring viewing period or unrestricted public access is imposed unless specifically and reasonably agreed in writing.

40. SALE OF THE PREMISES

40.1 A sale does not by itself cancel this lease. The Landlord must disclose the tenancy to the purchaser and arrange lawful continuity of obligations and the Deposit with a written account of principal and interest. The Tenant must receive verified successor and payment details.

40.2 This agreement grants neither an option to buy nor a right of first refusal unless a separate signed provision expressly does so. A purchase requires its own legally compliant sale agreement.

40.3 Any sales commission depends on a separate enforceable mandate and applicable law. This lease does not deem an agent to have caused a sale or insert a commission rate into a future transaction.

41. SPECIAL CONDITIONS

41.1 {{rules.special_conditions}}

41.2 A special condition must identify any clause it changes and cannot override mandatory law.

SIGNED BY THE PARTIES

By signing, the parties agree to the completed schedule, clauses 2 to 41 and the attachments identified in item 1.10. Any uncompleted optional suretyship is excluded.

SIGNED at .......................................... on this ........ day of ......................

Landlord or authorised representative
Full name: {{landlord.name}}
Identity or registration number: {{landlord.identity_number}}
Capacity and authority, if applicable: ...............................................
Signature: ..............................................

Tenant 1
Full name: {{tenant.primary_name}}
Identity or passport number: {{tenant.primary_identity_number}}
Signature: ..............................................

Tenant 2 if applicable
Full name: ..............................................
Identity or passport number: ..............................................
Signature: ..............................................

Tenant 3 if applicable
Full name: ..............................................
Identity or passport number: ..............................................
Signature: ..............................................

AS WITNESSES:

Witness 1: ...........................................
Witness 2: ...........................................

Additional signatories or signed continuation sheet reference: ......................
$BODY$, now()
from system_lease_templates t
where t.name = 'Residential lease — South Africa';
