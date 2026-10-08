-- 0032_master_lease_fields.sql
-- Storage for the merge fields the master lease needs.
--
-- The master lease (0031) is a completed form, and the parts it could not fill
-- were left as blank lines for someone to write in by hand. A blank line on a
-- generated PDF is a blank line on every lease that landlord ever issues, so
-- each of these now has somewhere to live and fills itself.
--
-- Three go on the organisation, because they describe the agency rather than any
-- one lease. The rest go on the lease's agreement terms, beside the ones already
-- there.
--
-- The deposit refund account is the TENANT'S bank account. It is sealed with the
-- same authenticated encryption as the landlord's account number, and only the
-- last four digits are kept in the clear, because a generated agreement must be
-- able to show which account without the database holding a readable list of
-- every tenant's banking details.

alter table organisation_profiles
  add column agent_registration_number text
    check (agent_registration_number is null or length(btrim(agent_registration_number)) between 1 and 60),
  add column agent_practitioner text
    check (agent_practitioner is null or length(btrim(agent_practitioner)) between 1 and 160),
  add column agent_certificate_number text
    check (agent_certificate_number is null or length(btrim(agent_certificate_number)) between 1 and 60);

comment on column organisation_profiles.agent_practitioner is
  'The responsible practitioner named on the agency''s Fidelity Fund certificate. '
  'Shown on a generated lease so the tenant can check the agency is in good standing.';

alter table lease_agreement_terms
  -- Periods. Smallint with a sane ceiling: a lease that gives the landlord 500
  -- days to return a deposit is a typo, not a term.
  add column deposit_refund_days smallint
    check (deposit_refund_days is null or deposit_refund_days between 0 and 365),
  add column defects_notice_days smallint
    check (defects_notice_days is null or defects_notice_days between 0 and 365),

  -- Money in minor units, like every other amount in this database.
  add column maintenance_callout_fee_minor bigint
    check (maintenance_callout_fee_minor is null or maintenance_callout_fee_minor >= 0),
  add column early_cancellation_cap_minor bigint
    check (early_cancellation_cap_minor is null or early_cancellation_cap_minor >= 0),

  add column named_occupants text
    check (named_occupants is null or length(named_occupants) <= 2000),
  add column payment_reference text
    check (payment_reference is null or length(btrim(payment_reference)) between 1 and 80),

  -- Where the deposit goes back to.
  add column refund_account_holder text
    check (refund_account_holder is null or length(btrim(refund_account_holder)) between 1 and 160),
  add column refund_bank_name text
    check (refund_bank_name is null or length(btrim(refund_bank_name)) between 1 and 120),
  add column refund_branch_code text
    check (refund_branch_code is null or refund_branch_code ~ '^[0-9]{4,10}$'),
  add column refund_account_number_cipher bytea,
  add column refund_account_number_last4 text
    check (refund_account_number_last4 is null or refund_account_number_last4 ~ '^[0-9]{4}$'),

  -- The cipher and the last four travel together or not at all. Either half
  -- alone means a half-written record, which is worse than none.
  add constraint lease_agreement_terms_refund_account_complete check (
    (refund_account_number_cipher is null) = (refund_account_number_last4 is null)
  );

comment on column lease_agreement_terms.refund_account_number_cipher is
  'The tenant''s account number for the deposit refund, sealed. Never stored in '
  'the clear, and shown on a generated agreement only as the last four digits '
  'unless the caller opens it deliberately.';

comment on column lease_agreement_terms.early_cancellation_cap_minor is
  'An upper limit on a reasonable early cancellation charge, in minor units. A '
  'ceiling only: it is not evidence that a charge up to it is reasonable, and '
  'clause 21 of the master lease says so.';
