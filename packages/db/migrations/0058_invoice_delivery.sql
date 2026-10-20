-- ---------------------------------------------------------------------------
-- 0058  Sending an invoice to the person who owes it
-- ---------------------------------------------------------------------------
--
-- The product could raise a month's invoices and could not send one. A billing
-- run posts charge documents to the ledger, and from there a resident could
-- only find them by signing into the portal and looking — which assumes they
-- knew there was something to look at.
--
-- THE DISTINCTION THIS MIGRATION INSISTS ON: an invoice's accounting status and
-- its delivery state are different facts about different things.
--
--   `charge_documents.status` is draft → posted → reversed. It says whether
--   the money is in the books. A posted document is immutable, and nothing
--   about communicating it may touch that row.
--
--   Delivery is whether somebody told the resident. It changes repeatedly, it
--   can fail, it can be retried, and it has no effect on a balance whatsoever.
--
-- So delivery lives in its own table. A row exists only once an operator has
-- said the invoice is ready to go; no row means nobody has decided yet, which
-- is the honest reading of silence.
--
-- An invoice must be POSTED before it can be marked ready. Emailing somebody a
-- draft invites them to pay against a figure that is not in anyone's accounts
-- and may still change.

-- `notifications` had no composite key, because nothing referenced it until a
-- delivery wanted to point at the message it produced.
alter table notifications
  add constraint notifications_org_id_key unique (organisation_id, id);

create table invoice_deliveries (
  organisation_id uuid not null references organisations (id) on delete cascade,
  document_id     uuid not null,
  -- ready       — an operator has said this one is to go out
  -- queued      — handed to the worker, nothing sent yet
  -- sent        — a provider ACKNOWLEDGED it. Never written on the strength of
  --               having tried; see notifications.status for the same rule
  -- undelivered — the attempt completed and the message did not go. The reason
  --               is in `outcome_detail`, including "no email provider is
  --               configured", which is this deployment's actual state
  -- suppressed  — there is nobody to send to: no email address on file
  state           text not null default 'ready'
                  check (state in ('ready', 'queued', 'sent', 'undelivered', 'suppressed')),
  -- Where it was going. Recorded at the moment of queueing rather than read
  -- back later, so the record says who was written to even if the resident's
  -- address changes afterwards.
  recipient_email citext,
  recipient_resident_id uuid,
  marked_ready_at timestamptz not null default now(),
  marked_ready_by uuid references auth.users (id),
  queued_at       timestamptz,
  attempts        integer not null default 0,
  last_attempt_at timestamptz,
  outcome_detail  text,
  notification_id uuid,
  sent_at         timestamptz,
  primary key (document_id),
  unique (organisation_id, document_id),
  foreign key (organisation_id, document_id)
    references charge_documents (organisation_id, id) on delete cascade,
  foreign key (organisation_id, recipient_resident_id)
    references resident_profiles (organisation_id, id) on delete set null,
  foreign key (organisation_id, notification_id)
    references notifications (organisation_id, id) on delete set null,
  -- 'sent' is a claim about a provider's acknowledgement, so it cannot exist
  -- without the moment it happened.
  constraint invoice_deliveries_sent_has_time
    check ((state = 'sent') = (sent_at is not null))
);

comment on table invoice_deliveries is
  'Whether an invoice has been sent to the resident, and what happened. '
  'Separate from charge_documents because a posted invoice is immutable and '
  'delivery is not part of the accounting record.';

create index invoice_deliveries_state_idx
  on invoice_deliveries (organisation_id, state);

alter table invoice_deliveries enable row level security;

create policy invoice_deliveries_select on invoice_deliveries
  for select using (
    organisation_id in (select app.member_organisation_ids())
    or organisation_id in (select app.support_organisation_ids())
  );
create policy invoice_deliveries_write on invoice_deliveries
  for all
  using (organisation_id in (select app.member_organisation_ids()))
  with check (organisation_id in (select app.member_organisation_ids()));

grant select, insert, update, delete on invoice_deliveries
  to propertyos_app, propertyos_worker;

/* ------------------------------------------------- the covering message */

-- What the resident actually reads. One per organisation, because the voice is
-- the landlord's: a letting agency and a single-flat owner do not write the
-- same email. Until one is saved, the product's own default is used, which is
-- in the domain rather than seeded here so that improving it does not require
-- a migration and does not overwrite anybody's edits.
create table organisation_message_templates (
  organisation_id uuid not null references organisations (id) on delete cascade,
  template_key    text not null check (template_key in ('invoice.issued')),
  subject         text not null check (length(btrim(subject)) between 3 and 200),
  body            text not null check (length(btrim(body)) between 20 and 4000),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id),
  primary key (organisation_id, template_key)
);

comment on table organisation_message_templates is
  'The landlord''s own wording for messages to residents, with {{merge.fields}} '
  'the product fills in. Absent means the product default is used.';

alter table organisation_message_templates enable row level security;

create policy organisation_message_templates_select on organisation_message_templates
  for select using (
    organisation_id in (select app.member_organisation_ids())
    or organisation_id in (select app.support_organisation_ids())
  );
create policy organisation_message_templates_write on organisation_message_templates
  for all
  using (app.has_permission(organisation_id, 'organisation.settings.manage'))
  with check (app.has_permission(organisation_id, 'organisation.settings.manage'));

grant select, insert, update, delete on organisation_message_templates
  to propertyos_app, propertyos_worker;

/* ------------------------------------------------------------ permission */

insert into permissions (key, description) values
  ('invoice.send', 'Mark invoices ready to send, and send them to residents')
on conflict (key) do nothing;

-- Sending a month's invoices is a communication with every resident at once,
-- in the landlord's name. It sits with the roles that already decide what the
-- organisation says and what it charges — not with everyone who can read a
-- lease.
insert into role_permissions (role_key, permission_key)
select r.key, 'invoice.send'
from roles r
where r.key in ('org_admin', 'finance_approver')
on conflict do nothing;

select app.assert_table_privileges();
