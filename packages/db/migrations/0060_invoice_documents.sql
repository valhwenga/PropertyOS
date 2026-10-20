-- ---------------------------------------------------------------------------
-- 0060  An invoice a tenant can hold
-- ---------------------------------------------------------------------------
--
-- Until now an invoice existed only as rows: a charge document, its lines, and
-- a line on a statement. A tenant who asked "send me the invoice" could be sent
-- a statement, which is a different document answering a different question —
-- a statement says what the account has done, an invoice says what was charged
-- on one date and what reference to quote when paying it.
--
-- Two things are added here.
--
-- 1. A CHOICE OF DESIGN, per organisation, from a vetted list. The same
--    reasoning as the accent and the typeface in 0055: a key this product
--    offers, never a layout an administrator composes. Each design is checked
--    for the things an invoice must not lose — the reference, the due date,
--    the landlord's identity — so a landlord choosing the one they like best
--    cannot choose one that omits something.
--
-- 2. WHAT A TENANT MAY READ ABOUT THEIR LANDLORD on such a document. A
--    resident is a member of nothing, so `organisation_profiles` is closed to
--    them. An invoice must name who is charging: their registered name, their
--    registration and VAT numbers where they have them, and an address.
--    Every one of those already appears on the lease this same tenant signed,
--    so this discloses nothing new to them; it saves them finding the
--    paperwork. The sealed identity number of a natural-person landlord is NOT
--    returned, here or anywhere near a document that is emailed.

/* ------------------------------------------------------- the chosen design */

alter table organisation_branding
  add column if not exists invoice_template text not null default 'classic'
    check (invoice_template in ('classic', 'modern', 'compact'));

comment on column organisation_branding.invoice_template is
  'Which invoice layout this organisation issues. A key from a vetted list, '
  'never a layout an administrator composes: every design carries the payment '
  'reference, the due date and the landlord''s identity.';

/* ------------------------------------ what a tenant may read about who bills them */

create or replace function app.resident_invoice_landlord(p_lease uuid)
returns table (
  legal_name text,
  trading_name text,
  registration_number text,
  vat_number text,
  physical_address text,
  postal_address text,
  phone text,
  email text,
  agent_name text,
  agent_contact text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.legal_name, p.trading_name, p.registration_number, p.vat_number,
         p.physical_address, p.postal_address, p.phone, p.email::text,
         p.agent_name, p.agent_contact
  from public.leases l
  join public.organisation_profiles p on p.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  limit 1;
$$;

comment on function app.resident_invoice_landlord(uuid) is
  'The landlord''s business identity for an invoice: the same facts that are '
  'already printed on the lease this resident signed. Never the sealed '
  'identity number.';

grant execute on function app.resident_invoice_landlord(uuid)
  to propertyos_app, propertyos_worker;

/* ------------------------------- the design a resident's own invoice uses */

-- `app.resident_branding` already tells the portal which accent and typeface
-- to wear. An invoice a resident downloads must be the SAME document their
-- landlord issues, so the chosen design travels with it. Nothing else about
-- the organisation is added here; the function still returns no name, no
-- timestamps and nothing identifying.
-- Dropped and recreated rather than replaced: a function's return type cannot
-- be changed in place, and adding a column to this one is the point.
drop function if exists app.resident_branding(uuid);

create function app.resident_branding(p_lease uuid)
returns table (
  accent text,
  typeface text,
  has_logo boolean,
  invoice_template text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.accent, b.typeface, b.logo_bytes is not null, b.invoice_template
  from public.leases l
  join public.organisation_branding b on b.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  limit 1;
$$;

comment on function app.resident_branding(uuid) is
  'The accent, typeface, whether a logo exists and the invoice design, for a '
  'resident of this lease.';

grant execute on function app.resident_branding(uuid) to propertyos_app, propertyos_worker;

select app.assert_table_privileges();
