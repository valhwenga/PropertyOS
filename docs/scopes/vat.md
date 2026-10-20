# Scope — VAT on charges, invoices and credit notes

**Status:** scoped, not built · **Date:** 2026-10-20 · **Owner:** unassigned

This is what would have to be true for this product to put tax on a document.
Nothing here is implemented. It is written now because the invoice work made
the gap visible, and because the gap has a shape that is easy to get wrong in a
way that costs a customer money with SARS.

## 1. The thing most VAT features get wrong

**Residential letting is exempt, not zero-rated, and not standard-rated.**

Under section 12(c) of the Value-Added Tax Act, the supply of a *dwelling*
under a lease is an **exempt supply**. A landlord letting flats to people who
live in them:

- charges **no** VAT on the rent, whether or not they are a registered vendor;
- may **not** issue a tax invoice for it;
- may **not** deduct input tax on the costs of making that supply.

Commercial letting — offices, shops, warehouses, and holiday or short-stay
accommodation on the terms the Act sets out — is a **standard-rated** supply at
15% when the landlord is a registered vendor.

So VAT is not a setting on an organisation. It is a property of **the supply**,
which means it is decided per lease, and the product must be able to hold
"this landlord is a vendor, and this particular lease is exempt anyway".

Consequences for anything built later:

| Case | Rent | Utilities recovered | Document |
| --- | --- | --- | --- |
| Residential, landlord not a vendor | no VAT | no VAT | **Invoice** |
| Residential, landlord IS a vendor | exempt | exempt where supplied as part of the dwelling | **Invoice**, and the exemption stated |
| Commercial, landlord a vendor | 15% | 15% | **Tax invoice** |
| Commercial, landlord not a vendor | no VAT | no VAT | **Invoice** |

A municipal recovery in a commercial lease follows the lease, not the
municipality's own treatment — a landlord recovering a water account is making
a taxable supply of water to the tenant, and the fact that the municipality
billed them exempt or zero-rated does not travel.

**This is why the current documents say INVOICE and never TAX INVOICE.** That
was changed in the same work that scoped this: a document calling itself a tax
invoice is a document a tenant's accountant will try to claim against.

## 2. What a tax invoice must carry

Section 20(4) of the Act, for a supply over R5,000 — a full tax invoice:

1. the words **"tax invoice"**, "VAT invoice" or "invoice";
2. the supplier's **name, address and VAT registration number**;
3. the recipient's **name and address**, and their VAT number where they are a
   vendor;
4. a **serial number** and the **date of issue**;
5. a **description** of the goods or services;
6. the **quantity or volume**;
7. either the value, the tax and the consideration separately, **or** the
   consideration with a statement that it includes tax and the rate charged.

Of these the product already has 1, 2 (bar the address requirement being
enforced), 3 (name; the address is the leased property), 4, 5 and 6. What is
missing is 7 — the only one that needs schema.

An abridged tax invoice (supply under R5,000) may omit the recipient's details.
Not worth implementing separately; the full form is always acceptable.

A **credit note** has its own requirements (section 21): the words "credit
note", the original invoice's particulars, the amount credited and the tax on
it, and the reason. The product already records a reason and links the original
document, so only the tax split is missing.

## 3. Schema

```sql
-- Per organisation: are they a vendor at all, and from when.
alter table organisation_profiles
  add column vat_registered_on date,            -- null = not a vendor
  add column vat_basis text check (vat_basis in ('invoice', 'payments'));

-- Per lease: what kind of supply this is. NOT derivable from property_type —
-- a flat let to a company as staff accommodation is still a dwelling, and a
-- house run as a guesthouse is not.
alter table leases
  add column vat_treatment text not null default 'exempt_dwelling'
    check (vat_treatment in ('exempt_dwelling', 'standard_rated', 'zero_rated'));

-- Per rate, with dates: 14% → 15% happened on 1 April 2018 and will happen
-- again. A rate hard-coded in code is a rate that is wrong for one month and
-- silently restates history.
create table vat_rates (
  code         text primary key,        -- 'standard'
  rate_bp      integer not null,        -- basis points: 1500 = 15%
  effective_on date not null,
  ...
);

-- Per charge line: what was actually charged. Stored, never recomputed.
alter table charge_lines
  add column tax_code text,                     -- 'standard' | 'exempt' | 'zero'
  add column tax_rate_bp integer,               -- as applied, not as looked up
  add column tax_minor bigint not null default 0,
  add column amount_excluding_tax_minor bigint; -- so neither has to be derived
```

The rule that matters: **`amount_minor` stays the amount the tenant owes**
(tax-inclusive), and the split is stored beside it. Every existing query,
statement, allocation and report keeps working untouched, and no posted
document can change its meaning when a rate changes later.

## 4. Ledger

A VAT-registered landlord's charge posts three legs, not two:

```
debit  Resident receivable       1 150.00
credit Rental income             1 000.00
credit VAT output control          150.00
```

That needs an `output_tax_control` account role in `resolveSystemAccounts`, and
the same on the credit-note path in reverse. `assertBookBalances` already
proves every journal balances, so the test that matters is the one asserting
that the control account equals the sum of `tax_minor` on posted lines for the
period — which is the figure a VAT201 is filed from.

Rounding is per line, not per invoice, and half-up on the minor unit. Both
choices must be stated in the code where they happen, because a landlord
reconciling to a cent will find them.

## 5. Where it surfaces

- **Settings → Organisation:** VAT number (already captured), registration
  date, basis. The VAT number alone must not switch anything on — a landlord
  may be a vendor for a commercial portfolio and let dwellings as well.
- **Lease:** the treatment, with the default `exempt_dwelling` and a one-line
  explanation of why, because getting it wrong is the expensive case.
- **Raise a charge:** shows the tax that will be added, before posting.
- **Invoice designs:** a tax column and a totals block (excluding, VAT at the
  rate, including). All three designs must grow it; the layout test must then
  assert it on all three.
- **Reports:** a VAT summary per period — output tax by rate, and the exempt
  total, which a vendor needs for the apportionment calculation.
- **Credit notes:** tax split mirrored, "credit note" wording already present.

## 6. What this does NOT cover, and must say so

- **Input tax, apportionment and the 95% rule.** A vendor making both taxable
  and exempt supplies may only deduct input tax on the taxable part. That is an
  accounting-system feature, not a rental-system one, and this product should
  say it does not do it rather than implying a complete VAT position.
- **The payments (cash) basis.** Only available to small vendors; it changes
  when output tax arises from invoice date to receipt date, which means the
  allocation engine, not just the invoice. Scope it separately or refuse it.
- **VAT201 submission.** Out of scope: this product produces the figures, a
  practitioner files them.
- **Imported services, agents acting as principal, and the special rules for a
  property practitioner collecting on a landlord's behalf.** Each one changes
  who the supplier is. Out of scope until a customer needs it, and then with
  advice, not with a guess.

## 7. Effort, honestly

| Piece | Size |
| --- | --- |
| Schema, rates table, backfill of `tax_code = 'exempt'` | small |
| Posting path and the third journal leg | medium |
| Invoice and credit-note rendering across three designs | medium |
| Settings, lease treatment, raise-a-charge preview | medium |
| Reports (VAT summary) | small |
| Tests: rounding, rate change across a period boundary, exempt vs standard, control-account reconciliation | **the largest piece** |

The tests are the largest piece on purpose. The failure mode of this feature is
not a crash; it is a number that is quietly wrong on a document somebody files.

## 8. The decision to make before any of it

**Who is the first customer that needs it?** A residential-only landlord gains
nothing from this work and loses nothing by its absence, because their supply
is exempt either way. The feature is worth building the day the product takes
on a commercial or mixed portfolio — and on that day it is worth building
properly, because the alternative is a spreadsheet beside the product, which is
where the error that reaches SARS actually comes from.

Until then, the honest position is the one the product now takes: documents say
**INVOICE**, no tax is shown or implied, the VAT number is printed where a
landlord has recorded one, and `docs/known-limitations.md` says plainly that no
VAT is calculated.
