-- ---------------------------------------------------------------------------
-- 0046  The banking details a resident pays into
-- ---------------------------------------------------------------------------
--
-- The portal asks a resident to pay and never says where. Blueprint §9 puts
-- verified banking details in the portal for exactly one reason: redirection
-- fraud. A resident who receives an email saying "our banking details have
-- changed" needs somewhere authoritative to check, and the only authority is
-- the record the landlord verified.
--
-- A resident is not a member of the organisation, so `bank_accounts_select`
-- correctly filters the table away from them. Widening that policy would hand
-- a resident the whole row, including the sealed number. This returns the
-- fields a person needs to CHECK details they already hold, and nothing else.
--
-- What it deliberately does NOT return is the full account number. Migration
-- 0038 seals it and `bank-accounts.ts` says the sealed value never leaves that
-- module; unsealing it for a web page is a decision with its own blast radius,
-- not a side effect of a design pass. So a resident can confirm the account
-- they are about to pay, and a resident who has never paid still asks their
-- landlord for the number.
--
-- Only a VERIFIED, active operating account is returned. An unverified account
-- is not an authority to pay into, and saying nothing is the honest answer:
-- the screen tells the resident to ask rather than inventing confidence.

create or replace function app.resident_payment_details(p_lease uuid)
returns table (
  bank_name text,
  account_holder text,
  account_number_last4 text,
  branch_code text,
  verified_at timestamptz,
  verification_method text,
  payment_reference text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.bank_name, b.account_holder, b.account_number_last4, b.branch_code,
         b.verified_at, b.verification_method,
         -- The lease reference is what the landlord reconciles against. A
         -- payment with no reference is the single commonest reason money sits
         -- in suspense instead of clearing somebody's arrears.
         l.reference as payment_reference
  from public.leases l
  join public.bank_accounts b on b.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
    and b.account_role = 'operating'
    and b.is_active
    and b.verified_at is not null
  order by b.created_at
  limit 1;
$$;

comment on function app.resident_payment_details(uuid) is
  'Verified banking details for a resident of this lease. Never returns the full account number.';

grant execute on function app.resident_payment_details(uuid) to propertyos_app, propertyos_worker;
