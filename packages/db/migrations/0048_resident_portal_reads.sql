-- ---------------------------------------------------------------------------
-- 0048  What the resident portal may read, and one field it needs
-- ---------------------------------------------------------------------------
--
-- Three narrow reads and one new column. Each exists because the portal has to
-- answer a question a resident is entitled to ask, and the table that holds the
-- answer also holds something they must never see.
--
--  * Payment instructions, including the SEALED account number. 0038 seals it
--    and `bank-accounts.ts` keeps the sealed bytes inside that module; this
--    returns them to the domain layer, which opens them under a permission
--    check and writes an audit entry. Nothing opens here, in SQL.
--
--    The full number is not a new disclosure to this reader: it is already
--    printed in the lease agreement they sign, generated from the same cipher
--    with the same context. What is new is that they can get it without
--    finding the paperwork.
--
--  * The work order behind their own maintenance ticket: when somebody is
--    coming, who, and what they said when they finished. The row also carries
--    the spending ceiling and the approver, which are the landlord's business,
--    so this returns neither.
--
--  * An emergency contact on the organisation profile. The portal tells a
--    resident to phone somebody when water is coming through the ceiling, and
--    there was no field to tell them who. A product must not invent a number,
--    and until one is configured the screen says so.

alter table organisation_profiles
  add column if not exists emergency_contact text;

comment on column organisation_profiles.emergency_contact is
  'Who a resident should phone out of hours. Shown in the resident portal; never invented.';

-- ------------------------------------------------- payment instructions

create or replace function app.resident_payment_instructions(p_lease uuid)
returns table (
  bank_account_id uuid,
  organisation_id uuid,
  bank_name text,
  account_holder text,
  account_number_last4 text,
  account_number_cipher bytea,
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
  select b.id, b.organisation_id, b.bank_name, b.account_holder,
         b.account_number_last4, b.account_number_cipher, b.branch_code,
         b.verified_at, b.verification_method, l.reference
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

comment on function app.resident_payment_instructions(uuid) is
  'The one account a resident of this lease should pay into, sealed number included. '
  'The caller opens the number under its own check and audit; this never opens it.';

grant execute on function app.resident_payment_instructions(uuid) to propertyos_app, propertyos_worker;

-- ------------------------------------------------------- the work order

create or replace function app.resident_ticket_work(p_ticket uuid)
returns table (
  appointment_at timestamptz,
  status text,
  completed_at timestamptz,
  completion_note text,
  vendor_name text,
  vendor_category text
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.appointment_at, w.status::text, w.completed_at, w.completion_note,
         -- Name and trade category only. A contractor's own phone number and
         -- email are the landlord's relationship to manage, and a resident who
         -- needs to reach somebody reaches the landlord.
         v.name, v.category
  from public.work_orders w
  join public.maintenance_tickets t on t.id = w.ticket_id
  left join public.vendors v on v.id = w.vendor_id
  where w.ticket_id = p_ticket
    and t.lease_id is not null
    and app.can_access_lease_as_resident(t.lease_id)
  order by w.created_at desc
  limit 1;
$$;

comment on function app.resident_ticket_work(uuid) is
  'Appointment, contractor and completion for a resident''s own ticket. '
  'Never returns the spending ceiling, the approver or any quotation.';

grant execute on function app.resident_ticket_work(uuid) to propertyos_app, propertyos_worker;

-- -------------------------------------------- the emergency contact, read

create or replace function app.resident_emergency_contact(p_lease uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(trim(op.emergency_contact), '')
  from public.leases l
  join public.organisation_profiles op on op.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  limit 1;
$$;

grant execute on function app.resident_emergency_contact(uuid) to propertyos_app, propertyos_worker;
