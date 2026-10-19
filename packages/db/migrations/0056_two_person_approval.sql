-- ---------------------------------------------------------------------------
-- 0056  Configurable two-person approval
-- ---------------------------------------------------------------------------
--
-- §4 asks for two-person approval, configurable, for larger customers. Until
-- now every approval in this product was one signature: a deposit payout, a
-- supplier cost, a maintenance quotation. Deposits at least separate the
-- requester from the approver, so no single person could both prepare and
-- authorise one. A supplier cost had no such rule at all — the person who
-- drafted it could post it.
--
-- Two tables, deliberately:
--
--   * `approval_policies` is the setting. One row per money action, saying how
--     many signatures that action needs and above what amount. The default is
--     one, which is exactly today's behaviour, so an organisation that changes
--     nothing notices nothing.
--
--   * `approval_signatures` is the record. One row per person per subject,
--     which makes "who approved this, and when" answerable for any of the
--     three flows in one query, and makes a second approval impossible to fake
--     by clicking twice: the unique index refuses the same signer twice.
--
-- The signatures table is the state. An expense waiting for a second approver
-- is still a draft, an unapproved payout request is still pending, and neither
-- has moved a cent — the signature rows are what say how far along it is. That
-- is on purpose: a half-approved payment must not exist in the ledger in any
-- form, and a status column that says "half approved" invites a query that
-- treats it as approved.

create table approval_policies (
  organisation_id uuid not null references organisations (id) on delete cascade,
  -- The money actions this applies to. Adding one means teaching the command
  -- that performs it to record a signature, so the list is closed.
  action_key      text not null check (action_key in (
                    'deposit.payout', 'expense.approve', 'maintenance.quote.approve')),
  -- One is today's behaviour. Two is the §4 control. There is deliberately no
  -- three: a rule nobody can satisfy is a rule that gets switched off.
  approvals_required integer not null default 1
                  check (approvals_required between 1 and 2),
  -- Below this, one signature is enough. Zero means "every amount", which is
  -- what a cautious organisation will choose and what the screen says plainly.
  threshold_minor bigint not null default 0 check (threshold_minor >= 0),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id),
  primary key (organisation_id, action_key)
);

comment on table approval_policies is
  'How many approvers each money action needs, and above what amount. '
  'A missing row means one approver, which is the product default.';

create table approval_signatures (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  action_key      text not null,
  -- The thing being approved, named by its table and id rather than by a
  -- foreign key per flow: three flows, one record, one query.
  subject_table   text not null check (subject_table in (
                    'deposit_payout_requests', 'expenses', 'maintenance_quotes')),
  subject_id      uuid not null,
  signed_by       uuid not null references auth.users (id),
  signed_at       timestamptz not null default now(),
  -- Why they approved it. Carried into the action's own audit entry when the
  -- last signature completes it.
  note            text,
  -- One signature per person per subject. This is the control: a second
  -- approval has to come from a second person, and clicking approve twice
  -- cannot produce one.
  unique (organisation_id, subject_table, subject_id, signed_by)
);

comment on table approval_signatures is
  'Who has approved what. One row per person per subject; the unique index is '
  'what makes a second approval require a second person.';

create index approval_signatures_subject_idx
  on approval_signatures (organisation_id, subject_table, subject_id);

alter table approval_policies enable row level security;
alter table approval_signatures enable row level security;

-- Everyone who works here can see what the rules are and who signed what.
-- Withholding that would make "waiting for a second approver" unexplainable.
create policy approval_policies_select on approval_policies
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy approval_policies_write on approval_policies
  for all
  using (app.has_permission(organisation_id, 'organisation.settings.manage'))
  with check (app.has_permission(organisation_id, 'organisation.settings.manage'));

create policy approval_signatures_select on approval_signatures
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
-- Insert only, and only as yourself. The permission to approve each kind of
-- thing is checked by the command that records the signature; what the policy
-- adds is that nobody can sign in somebody else's name, and that a signature,
-- once given, cannot be edited or withdrawn.
create policy approval_signatures_insert on approval_signatures
  for insert with check (
    app.is_org_member(organisation_id) and signed_by = auth.uid()
  );

grant select, insert, update, delete on approval_policies
  to propertyos_app, propertyos_worker;
grant select, insert on approval_signatures to propertyos_app, propertyos_worker;
-- No update and no delete, for the same reason the audit trail has none.
revoke update, delete on approval_signatures from propertyos_app, propertyos_worker;

-- A payout request can now be partly approved. The status stays 'pending'
-- while it waits — see the note at the top about what a status column must not
-- be allowed to say — so nothing here changes except that the queue can tell
-- an approver the request is already carrying somebody's signature.

select app.assert_table_privileges();
