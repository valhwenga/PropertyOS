-- 0023_system_lease_templates.sql
-- Lease templates Spike provides to every customer.
--
-- These live in their OWN tables rather than in lease_templates, because
-- lease_templates.organisation_id is NOT NULL and must stay that way: every
-- customer-owned record carries its organisation. A template Spike publishes is
-- not owned by any customer, so giving it a nullable organisation_id would
-- weaken the rule that makes cross-organisation leakage impossible.
--
-- A customer never generates an agreement straight from one of these. They copy
-- it into their own templates and it becomes theirs — their edits, their
-- versions, their publication. Generation therefore still reads only
-- organisation-scoped rows, and nothing about the existing path changes.

create table system_lease_templates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  layout          app.lease_template_layout not null,
  -- Where the wording came from, so a customer can judge it before adopting it.
  provenance      text not null,
  summary         text not null,
  status          app.lease_template_status not null default 'draft',
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now()
);

create table system_lease_template_versions (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references system_lease_templates(id) on delete cascade,
  version         integer not null,
  body            text not null,
  published_at    timestamptz,
  published_by    uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  unique (template_id, version)
);

create index on system_lease_template_versions (template_id, version desc);

-- A published version is immutable, exactly as an organisation's own are.
create or replace function app.block_published_system_template_mutation()
returns trigger language plpgsql as $$
begin
  if old.published_at is not null then
    raise exception 'A published template version cannot be changed. Publish a new version instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger system_lease_template_versions_immutable
  before update on system_lease_template_versions
  for each row execute function app.block_published_system_template_mutation();

alter table system_lease_templates enable row level security;
alter table system_lease_template_versions enable row level security;

-- Any signed-in operator may READ a PUBLISHED system template: that is the
-- point of them. Drafts stay with Spike until published.
create policy system_lease_templates_read on system_lease_templates
  for select
  using (status = 'published' or app.is_platform_operator());

create policy system_lease_template_versions_read on system_lease_template_versions
  for select
  using (
    published_at is not null
    or app.is_platform_operator()
  );

-- Only Spike writes them. This is platform content, not customer content, so
-- unlike customer tables a platform operator legitimately has write access —
-- and only here.
create policy system_lease_templates_write on system_lease_templates
  for all
  using (app.is_platform_operator())
  with check (app.is_platform_operator());

create policy system_lease_template_versions_write on system_lease_template_versions
  for all
  using (app.is_platform_operator())
  with check (app.is_platform_operator());

grant select on system_lease_templates, system_lease_template_versions to propertyos_app;
grant insert, update, delete on system_lease_templates, system_lease_template_versions to propertyos_app;

select app.assert_table_privileges();
