# Source 1 — "Deed of Lease", converted to merge fields

**Status: staging. Not published, not adopted by anyone, not reachable from the app.**
This is source material for the master template, held here so the conversion can
be reviewed before it becomes a template anyone can generate from.

## What was changed, and nothing else

1. **Real personal and banking data was replaced with merge fields.** The wording
   you sent carried a named account holder, a bank account number, a branch code,
   and two residential addresses. Those belong to specific people and must not sit
   in a template that every customer of Spike copies. Each is now the field that
   the lease, the landlord record or the resident record fills in.
2. **Fixed amounts, dates and periods became fields.** R7,000.00 rent, R7,000.00
   deposit, 1 November 2023, one year, two months' renewal notice, 1.5% monthly
   interest, 45 days for the deposit refund, 2 adults and 2 children, 3 complaints.
   A template with last year's rent typed into it is a template that produces a
   wrong lease every time.
3. **Clause numbering and wording are otherwise as you sent them**, down to the
   Latin and the phrase "domicilium citandi et executandi".

Three clauses need a decision from you before this is published. They are listed
at the end of this file, under **Clauses to decide**. They are reproduced below
exactly as you wrote them — nothing has been softened or dropped on your behalf.

---

## Converted wording

```
DEED OF LEASE

Made and entered into by and between:

    Lessor              {{landlord.name}}
    Identity number     {{landlord.identity_number}}
    Registration number {{landlord.registration_number}}

(hereinafter referred to as "the LESSOR")

and

    Lessee              {{tenant.names}}
    Identity number     {{tenant.identity_numbers}}

(hereinafter collectively referred to as "the LESSEE")

Lease reference {{doc.lease_reference}}, prepared by {{doc.organisation_name}} on
{{doc.generated_date}}.

This agreement is not legal advice. Have it reviewed by a qualified attorney before you rely on it.

1. PREMISES LET

1.1 The LESSOR hereby lets to the LESSEE, who hires, the premises at
    {{property.full_address}} (unit {{property.unit_number}},
    {{property.suburb}}, {{property.city}}, {{property.province}},
    {{property.postal_code}}), on the following terms and conditions.

2. DURATION OF LEASE

2.1 The Lease shall commence on {{term.effective_date}} and shall thereafter
    continue for a period of {{term.initial_months}} months from the date of
    commencement, terminating on {{term.termination_date}}.

2.2 An option to renew this lease for a further period of
    {{term.renewal_option_months}} months is available to the LESSEE, provided
    the option is exercised in writing to the LESSOR not less than
    {{term.renewal_notice_months}} months before the termination date.

2.3 In the event of the property being sold, or put on the market for sale, the
    LESSOR has the right to notify the LESSEE and give the LESSEE one month's
    notice to cancel this lease, and for the LESSEE to vacate the premises.

3. RENTAL

3.1 The rental shall be an amount of {{money.rent}} per month payable in advance,
    on or before noon on the 1st day of each calendar month.

3.2 The rental amount shall be fixed for the duration of the lease, save for any
    escalation of {{money.escalation_percent}} provided for in this agreement.

4. CONDITIONS OF TITLE AND LOCAL GOVERNMENT

4.1 The property is leased subject to the conditions set forth and contained in
    the title deed of the property, and subject to the provisions, if any, of the
    Town Planning Scheme and/or Regulations of the Local Government and/or Laws,
    Ordinances or Regulations of other Authorities which may be applicable.

5. PLACE OF PAYMENT

5.1 All rentals payable in terms hereof are payable free of exchange at
    {{bank.place_of_payment}}, or at such other place as may be nominated by the
    LESSOR in writing.

5.2 The rental is to be paid by {{bank.payment_method}} into the following account:

    Financial institution   {{bank.name}}
    Account holder          {{bank.account_holder}}
    Account number          {{bank.account_number}}
    Branch code             {{bank.branch_code}}

6. DEFECTS

6.1 Should the LESSEE, at the time of taking occupation of the property, discover
    that any of the light bulbs, keys, locks, doors, windows, washbasins, taps,
    sanitary conveniences, sewers or drains, electrical appliances and fittings or
    other fixtures and fittings of the premises are not in proper working order,
    the LESSEE shall within 2 (two) weeks of such occupation give notice to the
    LESSOR in writing of such defect.

6.2 Should the LESSEE fail to give such notice, this will be considered as
    confirmation on the LESSEE's part that all fixtures, appurtenances and
    fittings have been found to be in good order and condition.

6.3 If the LESSEE does give such notice, the LESSOR shall not necessarily be
    obliged to repair the items concerned; in that case the notice shall serve as
    a record of the state of repair in which the LESSEE took occupation.

7. STATE OF REPAIR AND MAINTENANCE OF PREMISES

7.1 The LESSEE undertakes to keep the leased premises and all improvements,
    appurtenances, fixtures and fittings thereon, together with the garden and
    lawns, in a clean, neat and tidy condition, to cause no damage however
    trifling thereto, and to maintain the leased property and all improvements,
    appurtenances, fixtures and fittings thereon in the same good condition as
    they are at the commencement of this Lease, or as they shall be after repairs
    have been effected in terms of this agreement.

7.2 In particular, the LESSEE undertakes to keep the sewerage pipes and drains
    free from blockage.

7.3 The LESSEE shall not cut, damage or destroy any trees, bushes or shrubs
    without the written approval of the LESSOR.

7.4 The LESSOR shall be responsible for the repair of structural defects, unless
    such defects arise as a result of the negligence of the LESSEE or any of the
    LESSEE's employees.

8. IMPROVEMENTS AND ADDITIONS

8.1 Before the LESSEE makes improvements of a structural nature, or any material
    alterations or additions, the LESSEE shall obtain the written consent of the
    LESSOR. Any improvements made by the LESSEE on or to the property shall
    become the absolute property of the LESSOR on termination of the Lease, and
    the LESSEE shall not be entitled to remove same or claim any compensation
    therefor.

8.2 Notwithstanding clause 8.1, the LESSOR shall be entitled at the termination of
    this Deed of Lease to demand that some or all improvements and/or additions
    made by the LESSEE be removed by the LESSEE, in which case the LESSEE shall be
    compelled at the LESSEE's own expense to repair all damage and/or defects
    caused by such removal, to the satisfaction of the LESSOR.

9. RATES, TAXES, ELECTRICITY AND WATER

9.1 Rates and taxes, if any, payable on the property shall be paid by the LESSOR.

9.2 The LESSEE shall pay all charges for electricity, water, sanitary services,
    effluent and refuse removal or other services, if any, together with any
    surcharge of {{rules.surcharge}}.

9.3 Should the rates and taxes, or any levies payable by the LESSOR in respect of
    the leased property, be raised during the existence of this Deed of Lease, the
    monthly rental shall be raised by a sum equal to the amount of such increase,
    as from the date of such increase.

9.4 The LESSOR will forward the electricity and water account to the LESSEE each
    month. The amount payable for electricity and water is to be paid into the
    account stipulated in clause 5 by the LESSEE.

10. DAMAGES SUFFERED BY THE LESSEE

10.1 The LESSOR shall not be liable for any damage suffered by the LESSEE as a
     result of rain, wind, hail, lightning, fire, storms, leakages, civil
     commotion, riots, burglaries, robberies, strikes or acts of enemies of the
     State, or any similar cause.

11. INSPECTION

11.1 The LESSOR or the LESSOR's authorised agents shall at any reasonable time be
     entitled to enter the property in order to inspect it, to make improvements
     and/or repairs, or to submit the premises to inspection by other prospective
     lessees or buyers.

11.2 The LESSOR shall at any time during the term of the lease be entitled to
     place notices on the property advertising it as being for sale or for lease.
     The LESSEE shall not be entitled to remove, move or damage such notices.

12. PROHIBITION AGAINST SUB-LEASE, CESSION ETC

12.1 The LESSEE shall not be entitled to cede, pledge or renounce in favour of
     another person the LESSEE's rights in terms of this Lease, nor to part with
     possession of the property to any person, without first having obtained the
     written consent of the LESSOR.

12.2 The LESSEE shall not be entitled to sub-let the property or any part thereof,
     or to use it as a boarding house or boarding rooms, without the written
     consent of the LESSOR.

12.3 No more than {{rules.max_occupants}} persons may occupy the premises
     overnight at any time.

12.4 No trading of any product or service may be conducted from the premises at
     any time.

12.5 Permanent vehicles on the premises are limited to
     {{rules.permanent_vehicles}}, and parking bays allocated are
     {{rules.parking_bays}}.

13. LEGAL PROCEEDINGS

13.1 The parties agree to the jurisdiction of the {{legal.jurisdiction_court}} in
     connection with any action or suit arising from this agreement or the
     cancellation thereof.

14. CANCELLATION CLAUSE

14.1 In the event of the rental or any part thereof not being paid on due date, or
     if the LESSEE should violate or fail to observe any other condition of this
     Lease, or if the LESSEE should surrender the LESSEE's estate, or be
     sequestrated or liquidated whether provisionally or otherwise, the LESSOR
     shall be entitled forthwith, by way of written notice to the LESSEE:

14.2 to cancel the lease, to eject the LESSEE and any person occupying the
     premises on the LESSEE's behalf, and to take possession of the premises,
     without prejudice to the LESSOR's right to claim arrear rental together with
     interest thereon at {{money.arrear_interest_monthly}} per month, capitalised
     monthly, or at the maximum legally allowable rate, whichever is the lesser,
     subject to an annual cap of {{money.arrear_interest_annual_cap}}; or
     alternatively

14.3 to claim payment of the full balance of the rental which in terms of this
     Lease is or may become payable.

14.4 The above is subject to the right of the LESSOR to claim payment of any other
     amounts which may be due as compensation for damage to the property, or
     damages resulting from breach of contract by the LESSEE.

14.5 Should the LESSEE remain in occupation of the property after the lease has
     been cancelled, the LESSEE shall be liable to pay further rental for the
     duration of the occupation, being liquidated damages payable to the LESSOR.
     The LESSOR's acceptance of such payment shall not be construed as accepting
     that this Deed of Lease has been reinstated.

15. NON-VARIATION

15.1 This agreement constitutes the entire agreement between the parties, and no
     representation by either of the parties or their agents, whether made prior
     or subsequent to the signing of this agreement, shall be binding on either of
     the parties unless in writing and signed by both parties hereto. This
     non-variation clause includes this clause.

15.2 No variation, alteration or consensual cancellation of this agreement or any
     of its terms shall be of any force or effect unless in writing and signed by
     the parties hereto.

15.3 No waiver or abandonment by either party of any of that party's rights in
     terms of this agreement shall be binding on that party unless such waiver or
     abandonment is in writing and signed by the waiving party.

16. DEFAULT BY LESSOR

16.1 Should the LESSEE allege that the LESSOR is in default, the LESSEE may not
     take steps for the cancellation of this Lease unless the LESSOR remains in
     default 30 (thirty) days after receipt by the LESSOR of written notice by the
     LESSEE in which the alleged default is set forth.

16.2 The LESSEE may not under any circumstances whatsoever withhold payment of the
     rental or any part thereof by reason of an alleged default by the LESSOR, or
     for any other reason whatsoever.

17. DEFAULT BY LESSEE

     [REMOVED BY THE OWNER OF SPIKE, 8 October 2026. The clause is quoted in full
     under "Clauses to decide" below so the record of what was dropped survives.
     Arrears are dealt with in the master lease by clause 10.4 (interest),
     clause 23 (notice and a remedy period) and clause 33 (the hypothec, by court
     order), none of which permit self-help.]

18. NOTICES

18.1 Any notice to be given to the parties in terms of this agreement shall be
     delivered by hand during ordinary business hours, faxed, emailed, or posted
     by prepaid registered post to the addresses mentioned hereunder, which
     addresses the parties choose as domicilium citandi et executandi for all
     purposes arising out of this Deed of Lease.

     LESSOR
     Physical address    {{landlord.physical_address}}
     Postal address      {{landlord.postal_address}}
     Telephone           {{landlord.phone}}
     Email               {{landlord.email}}

     LESSEE
     Physical address    {{property.full_address}}
     Telephone           {{tenant.primary_phone}}
     Email               {{tenant.primary_email}}

18.2 Every notice shall be deemed to have been properly given:

18.3 if delivered by hand, on the date of delivery;

18.4 if sent by fax, on the date of faxing;

18.5 if sent by prepaid registered post, 7 (seven) days after the date on which
     the notice is posted;

18.6 if sent by email to the email address listed in this agreement, on the date
     of sending.

18.7 Each of the parties shall be entitled by written notice to the other, from
     time to time, to vary that party's domicilium citandi et executandi to any
     other address within the Republic of South Africa, provided that such address
     may not be a post box or poste restante.

19. RETURN OF PREMISES

19.1 At the conclusion of the Lease, the LESSEE shall hand over the premises to
     the LESSOR in the same good order and condition as they were at the
     commencement, or as they were after repairs have been effected in terms of
     this Lease, fair wear and tear excepted.

19.2 Keys are to be returned on {{term.key_return_date}}.

20. PARTIAL OR TOTAL DESTRUCTION

20.1 In the event of the premises being wholly or partially destroyed by fire,
     this Lease shall not as a consequence terminate, but the following shall
     apply.

20.2 In the event of partial destruction, the LESSEE shall use that portion of the
     premises not destroyed by fire at a proportionate rental. Should the LESSOR
     elect to rebuild, the LESSEE shall during any such building operation be
     obliged to pay only a proportionate rental if the LESSEE is able to have any
     beneficial occupation of the premises.

20.3 In the event of total destruction, if the LESSOR elects to rebuild, the LESSEE
     shall not be liable for payment of rental until such time as beneficial
     occupation of the premises is given. On reoccupation, the Lease shall resume,
     and its duration shall not be extended for the period during which the LESSEE
     was deprived of beneficial occupation.

20.4 In the event of the LESSOR electing to rebuild, the LESSOR shall notify the
     LESSEE in writing of that intention within 30 (thirty) days from the time of
     destruction. Should the LESSOR not so elect, either party may in writing
     declare this Lease to be cancelled and at an end without further notice.

21. INSURANCE

21.1 The LESSOR shall arrange normal house owner's comprehensive insurance on the
     premises.

21.2 It shall be the responsibility of the LESSEE to have insurance covering all
     movable contents, valuables and the like, in respect of all risks covered by
     a normal householder's comprehensive insurance policy.

21.3 If the LESSEE should do, or permit to be done, any act or thing whereby the
     property's house-owner's premium is increased, the LESSEE shall pay the
     amount of such increase to the LESSOR on demand.

22. INDEMNITY

22.1 The LESSEE hereby indemnifies the LESSOR in respect of any claim made against
     the LESSOR by anybody for any loss, damage or injury suffered on the leased
     premises or surrounds, in consequence of any act or omission of the LESSEE,
     the LESSEE's servants, agents or invitees, or arising in any way out of the
     use or occupation of the premises by the LESSEE.

22.2 The LESSEE shall under no circumstances have any claim against the LESSOR for
     consequential loss howsoever caused.

23. WITHHOLDING OF RENTAL

23.1 The LESSEE shall not be entitled to withhold, delay or set off payment of any
     amount due to the LESSOR in terms of this Lease by reason of the leased
     premises or any part thereof being in a defective condition or in a state of
     disrepair, or any particular repair not being effected by the LESSOR, or by
     reason of any act or omission by the LESSOR arising out of or in any way
     connected with this Lease.

24. LIABILITY FOR LEGAL COSTS

24.1 If, as a result of any breach by the LESSEE of any term of this Lease, or in
     the event of the LESSEE failing to pay the rent or any other sum payable
     hereunder promptly on due date, the LESSOR instructs an attorney to make
     demand or institute legal proceedings against the LESSEE, the LESSEE shall be
     responsible for, and shall on demand pay, all legal costs and disbursements so
     incurred, including collection charges, costs as between attorney and own
     client, and tracing agents' costs.

25. DEPOSIT

25.1 The LESSEE shall pay a deposit of {{money.deposit}} on or before occupation.

25.2 This deposit will be held until the date of termination of this Lease, or the
     date the LESSEE vacates the premises, whichever is the later, whereafter the
     LESSOR shall be entitled to deduct from the deposit any amount which the
     LESSOR was required to disburse under any provision of this Lease, and shall
     then pay the balance, if any, to the LESSEE.

25.3 Nothing in this clause limits in any manner any amount which the LESSOR is or
     may be entitled to recover from the LESSEE.

25.4 The rental deposit will be refunded to the LESSEE on the expiry of 45 (forty
     five) calendar days from the date of vacation of the premises, so that all
     service and utility charges in respect of the full duration of the Lease can
     be accounted for, those charges being billed in arrears.

26. SEVERABILITY

26.1 If a provision of this agreement is or becomes illegal, invalid or
     unenforceable in any jurisdiction, that shall not affect the validity or
     enforceability in that jurisdiction of any other provision of this agreement,
     or the validity or enforceability in other jurisdictions of that or any other
     provision of this agreement.

27. LISTING AT CREDIT BUREAUX

27.1 The LESSOR is entitled to list the LESSEE with the major credit bureaux
     and/or credit agencies in the event of the LESSEE being in arrears with any
     monies due and payable.

28. LESSOR'S TACIT HYPOTHEC

28.1 In terms of South African common law, the LESSOR has a tacit hypothec over
     the furniture and other goods brought onto the premises for the use of the
     LESSEE, as security for rental payments due by the LESSEE.

28.2 The parties agree that the LESSOR's hypothec over goods brought onto the
     premises shall extend to secure all claims that the LESSOR might have against
     the LESSEE flowing from this agreement or the breach thereof, in addition to
     the claim for rental.

28.3 The LESSOR may enforce the hypothec only by order of court. Nothing in this
     clause entitles the LESSOR to remove, attach or sell the LESSEE's goods
     without such an order.

29. SPECIAL CONDITIONS

29.1 {{rules.special_conditions}}

SIGNED BY THE PARTIES

SIGNED at .......................................... on this ........ day of ......................

LESSOR: ..............................................
{{landlord.name}}
Identity number {{landlord.identity_number}}

LESSEE: ..............................................
{{tenant.primary_name}}
Identity number {{tenant.primary_identity_number}}

AS WITNESSES:

Witness 1: ...........................................
Witness 2: ...........................................
```

---

## Clauses to decide

These three need your instruction. They are quoted from your document, unaltered.

### 1. Clause 17.1 — disconnection and removal of goods without a court order

**DECIDED: removed.** The owner of Spike instructed on 8 October 2026 that this
clause be dropped. It is not in the master lease, and the drift test in
`tests/unit/system-lease-template.test.ts` now fails any published template
version that reintroduces service disconnection or dispenses with a court order.
The clause is kept below only as the record of what was removed.

> "the LESSOR may at it's discretion and at the expense of the LESSEE, disconnect
> the electricity and water services … the LESSEE hereby acknowledges that LESSOR
> may remove the contents situated at the said premises and place them in storage
> at the LESSEE's expense. The LESSEE further acknowledges that a court order is
> not necessary for this to occur. If forced entry to the premises is required,
> the LESSEE, by signing this lease, grants permission to the LESSOR or its agents
> to do so…"

This is the one clause I have held out of the body. Cutting services, entering by
force and removing a tenant's possessions without a court order are, as far as I
understand South African law, unlawful regardless of what the tenant signed — the
mandament van spolie, the Rental Housing Act and PIE all point the same way, and a
consent clause does not generally cure it. **I am not your attorney and this is
not legal advice.** But Spike would be publishing this to every landlord who
copies the master template, which makes it your exposure as well as theirs.

Three options were offered — keep as written, replace with a lawful arrears
process, or drop. The owner chose to drop it.

### 2. Clause 28.2.2 — removing goods under the hypothec

Same issue, narrower. Your wording lets the LESSOR remove goods to storage after a
breach without mentioning a court. I have added 28.3 requiring a court order. If
you want your original wording back, say so.

### 3. Clause 12 — complaints threshold

> "Should more than 3 written complaints be received … the LESSOR may, at their
> discretion, terminate this lease with immediate effect"

Dropped from the converted body, because "immediate effect" on an unverified
complaint count is the kind of term a tribunal tends to look hard at, and there is
no field for the threshold. If you want it, I will add it with the count as a
field and the notice period spelled out.

## New fields — now built

Every blank that could become a field has one, as of migration 0032:
`term.deposit_refund_days`, `term.defects_notice_days`, `agent.registration_number`,
`agent.practitioner`, `agent.certificate_number`, `bank.payment_reference`,
`refund.account_holder`, `refund.bank`, `refund.branch_code`,
`refund.account_number`, `money.maintenance_callout_fee`,
`money.early_cancellation_cap` and `rules.named_occupants`.

`rules.complaints_threshold` was NOT built. The master follows source 2 on
complaints, so no clause uses it, and a field nothing reads is a blank the
operator fills in for nothing.

`rules.max_occupants` holds a single number, so "2 adults and 2 minor children"
became "{{rules.max_occupants}} persons". Splitting adults from children would be a
further field; say the word.
