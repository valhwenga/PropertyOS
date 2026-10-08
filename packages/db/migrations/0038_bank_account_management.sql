-- 0038_bank_account_management.sql
-- Where the landlord's rent is paid, and an honest record of how we know.
--
-- `bank_accounts` has carried a `verified_at` / `verified_by` pair since 0006
-- with nothing to say what "verified" meant. A timestamp alone reads as though
-- the account was checked against the bank, when in practice all that happened
-- was an operator typing a number and another operator looking at it. The
-- blueprint is explicit that the product must not present an unverified claim
-- as a verified one (§6, §10), so the method is now recorded alongside the
-- fact, and the interface states it in words.
--
-- The second half is the change history the blueprint asks for twice: §9
-- "require fresh authentication plus an audit trail for changes", and §22,
-- which lists bank detail changes among the threats a review must cover. A
-- diverted account number is the single most profitable attack on a letting
-- business, so a change leaves a permanent, append-only record of who, when,
-- from what, to what, why — and whether they had re-proved their identity.

-- ---------------------------------------------------------------------------
-- The account itself
-- ---------------------------------------------------------------------------

alter table bank_accounts
  add column account_holder text
    check (account_holder is null or length(btrim(account_holder)) between 2 and 160),
  add column verification_method text not null default 'none'
    check (verification_method in (
      'none',              -- nobody has checked anything
      'landlord_confirmed',-- the account holder told us, and we believe them
      'bank_document',     -- a bank letter or stamped statement was sighted
      'micro_deposit',     -- a small payment was sent and the value confirmed
      'provider_api'       -- a bank or provider API confirmed it
    )),
  add column verification_note text check (length(verification_note) <= 500),
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references auth.users (id);

comment on column bank_accounts.account_holder is
  'The name the account is held in. Shown beside the masked number so an '
  'operator can spot an account that belongs to the wrong person.';
comment on column bank_accounts.verification_method is
  'HOW the account was checked, not merely that someone clicked verify. '
  'Displayed verbatim; "landlord_confirmed" must never be presented as though '
  'a bank confirmed it.';

-- A verification is a fact about a method. The two move together or not at all.
alter table bank_accounts
  add constraint bank_accounts_verification_is_explained
    check (
      (verified_at is null and verification_method = 'none')
      or (verified_at is not null and verification_method <> 'none')
    );

-- ---------------------------------------------------------------------------
-- The history
-- ---------------------------------------------------------------------------

create table bank_account_changes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  bank_account_id uuid not null,
  -- What happened, in the business's words rather than a column diff.
  change_type     text not null check (change_type in (
    'created', 'account_number_changed', 'details_changed',
    'verified', 'verification_withdrawn', 'deactivated', 'reactivated'
  )),
  -- Only ever the last four digits. The whole point of sealing the number is
  -- that it does not lie around in a second table, least of all one whose
  -- reason for existing is to be read later.
  previous_last4  text check (previous_last4 ~ '^[0-9]{4}$'),
  new_last4       text check (new_last4 ~ '^[0-9]{4}$'),
  previous_bank_name text,
  new_bank_name   text,
  previous_account_holder text,
  new_account_holder text,
  -- Required by the application for every change. An audit trail that records
  -- what happened but not why is only half an audit trail.
  reason          text not null check (length(btrim(reason)) between 5 and 500),
  -- Whether the actor had re-proved their identity for this change. Recorded
  -- rather than assumed, so a later review can tell the difference between a
  -- change made under fresh authentication and one that was not.
  fresh_authentication boolean not null,
  changed_at      timestamptz not null default now(),
  changed_by      uuid references auth.users (id),
  unique (organisation_id, id),
  foreign key (organisation_id, bank_account_id)
    references bank_accounts (organisation_id, id) on delete cascade
);

create index bank_account_changes_account_idx
  on bank_account_changes (bank_account_id, changed_at desc);

comment on table bank_account_changes is
  'Append-only history of banking detail changes. Rows are never updated or '
  'deleted: a history that can be rewritten is not evidence of anything.';

alter table bank_account_changes enable row level security;

create policy bank_account_changes_select on bank_account_changes
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );

create policy bank_account_changes_insert on bank_account_changes
  for insert with check (app.is_org_member(organisation_id));

-- Select and insert only. No update policy and no delete policy are defined,
-- and the privileges are never granted either, so a history row cannot be
-- rewritten or removed by any request-scoped caller even if a policy were
-- added later by mistake.
grant select, insert on bank_account_changes to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
--
-- Separate from `organisation.settings.manage`, because changing the bank
-- account is not the same kind of act as changing the trading name, and the
-- people who may do one should not automatically be able to do the other.
-- Verification is separate again: the blueprint's finance separation says the
-- person who enters a detail should not be the only person who attests to it.

insert into permissions (key, description) values
  ('bank_account.read',   'View the organisation''s banking details, masked'),
  ('bank_account.manage', 'Add and change banking details'),
  ('bank_account.verify', 'Record that banking details were verified')
on conflict (key) do nothing;

insert into role_permissions (role_key, permission_key) values
  ('org_admin',        'bank_account.read'),
  ('org_admin',        'bank_account.manage'),
  ('org_admin',        'bank_account.verify'),
  ('finance_preparer', 'bank_account.read'),
  ('finance_approver', 'bank_account.read'),
  ('finance_approver', 'bank_account.verify')
on conflict do nothing;

-- Note which role is absent: finance_preparer may READ the masked details and
-- may not change them, mirroring §4's "cannot approve their own". org_admin and
-- finance_approver are both MFA-gated roles, so every one of these permissions
-- already requires a second factor before fresh authentication is even asked
-- for.
