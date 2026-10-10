-- ---------------------------------------------------------------------------
-- 0041  Deposit payout requests
-- ---------------------------------------------------------------------------
--
-- The approvals queue listed deposit deductions and refunds "awaiting
-- approval" by reading `deposit_events` where `approved_at is null`. The
-- database forbids such a row: `deposit_events_refund_controls` requires an
-- approver, evidence and a reason on every deduction, refund and transfer. So
-- the section could never show anything, and there was no way for one person
-- to prepare a payout for another to approve — the approver had to do the data
-- entry themselves, which is the opposite of segregation of duties.
--
-- A request lives here instead of in `deposit_events`, because the held
-- balance is the sum of that table. A request that has not been approved must
-- not reduce what the resident is owed, for the same reason an uploaded proof
-- of payment does not reduce their rent balance: it is a claim awaiting a
-- decision, not a movement.

-- The brief's rule that a customer record is referenced by (organisation, id)
-- together needs a matching key on the referenced side. `deposit_events` never
-- had one, because nothing referenced it until now.
alter table deposit_events
  add constraint deposit_events_org_id_key unique (organisation_id, id);

create table deposit_payout_requests (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations (id) on delete cascade,
  deposit_account_id uuid not null,
  kind            text not null check (kind in ('deduction', 'refund', 'transfer_to_rent')),
  -- Always positive here. The sign belongs to the ledger entry that approval
  -- posts, not to the request.
  amount_minor    bigint not null check (amount_minor > 0),
  currency_code   char(3) not null,
  effective_on    date not null,
  description     text not null check (length(btrim(description)) between 3 and 500),
  -- Required at request time, not at approval time. An approver should be
  -- deciding on evidence somebody has already produced, not chasing it.
  evidence_document_id uuid not null,
  requested_by    uuid not null references auth.users (id),
  requested_at    timestamptz not null default now(),
  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by      uuid references auth.users (id),
  decided_at      timestamptz,
  decision_reason text,
  -- The deposit event approval produced, so the request and the movement it
  -- authorised can be read as one story.
  event_id        uuid,
  unique (organisation_id, id),
  foreign key (organisation_id, deposit_account_id)
    references deposit_accounts (organisation_id, id) on delete cascade,
  foreign key (organisation_id, evidence_document_id)
    references documents (organisation_id, id) on delete restrict,
  foreign key (organisation_id, event_id)
    references deposit_events (organisation_id, id) on delete restrict,
  -- The requester may not decide their own request. The same rule the
  -- `deposit_events` table already enforces, stated again here so it holds at
  -- the point the decision is recorded rather than only downstream of it.
  constraint deposit_payout_requests_segregation check (
    decided_by is null or decided_by <> requested_by
  ),
  -- A decision is a decision: who, when, and why, or none of them.
  constraint deposit_payout_requests_decided check (
    status not in ('approved', 'declined')
    or (decided_by is not null and decided_at is not null
        and length(btrim(coalesce(decision_reason, ''))) >= 5)
  ),
  -- A withdrawal is not a decision somebody else made. The requester takes it
  -- back, so there is no approver to record, and recording them as one would
  -- make it look reviewed. Withdrawn and declined are different facts and the
  -- table keeps them different.
  constraint deposit_payout_requests_withdrawn check (
    status <> 'withdrawn'
    or (decided_by is null and decided_at is not null
        and length(btrim(coalesce(decision_reason, ''))) >= 5)
  ),
  -- Only an approval produces a movement.
  constraint deposit_payout_requests_event check (
    (status = 'approved') = (event_id is not null)
  )
);

create index deposit_payout_requests_pending_idx
  on deposit_payout_requests (organisation_id, status, requested_at);
create index deposit_payout_requests_account_idx
  on deposit_payout_requests (deposit_account_id, requested_at desc);

comment on table deposit_payout_requests is
  'A deduction, refund or transfer prepared by one person for another to '
  'approve. A pending request holds nothing: the deposit balance is the sum of '
  'deposit_events, and nothing is written there until somebody approves.';

alter table deposit_payout_requests enable row level security;

create policy deposit_payout_requests_select on deposit_payout_requests
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );

create policy deposit_payout_requests_insert on deposit_payout_requests
  for insert with check (app.is_org_member(organisation_id));

create policy deposit_payout_requests_update on deposit_payout_requests
  for update using (app.is_org_member(organisation_id));

-- No delete policy and no delete privilege: a request that was declined is
-- part of the record of what was asked for and refused.
grant select, insert, update on deposit_payout_requests to propertyos_app, propertyos_worker;

-- A decided request is closed. Reopening one, or editing the amount after a
-- decision, would let the thing approved differ from the thing requested.
create or replace function app.guard_payout_request_update()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if old.status <> 'pending' then
    raise exception 'A % payout request cannot be changed.', old.status
      using errcode = '23514';
  end if;
  if new.amount_minor <> old.amount_minor
     or new.kind <> old.kind
     or new.deposit_account_id <> old.deposit_account_id
     or new.requested_by <> old.requested_by
     or new.evidence_document_id <> old.evidence_document_id then
    raise exception 'The substance of a payout request is immutable. Withdraw it and raise another.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger deposit_payout_requests_guard
  before update on deposit_payout_requests
  for each row execute function app.guard_payout_request_update();

create trigger deposit_payout_requests_immutable
  before delete on deposit_payout_requests
  for each row execute function app.block_financial_mutation();
