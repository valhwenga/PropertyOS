-- ---------------------------------------------------------------------------
-- 0042  Reading the audit trail
-- ---------------------------------------------------------------------------
--
-- Every command in the product writes an audit entry, in the same transaction
-- as the change it describes, and nothing could read one back. The trail
-- existed for a dispute nobody could open: to answer "who changed this, when,
-- and why" somebody needed database access.
--
-- Reading it is a permission of its own. The trail is a record of what every
-- colleague did, including the reasons they typed, so the people who may
-- manage a property are not the people who may read it.

insert into permissions (key, description) values
  ('audit.read', 'Read the organisation''s audit trail')
on conflict (key) do nothing;

-- Only the organisation administrator. §4's separation of duties cuts both
-- ways: a finance approver may approve a payout and still have no business
-- reading what the maintenance manager wrote in a dispute note.
insert into role_permissions (role_key, permission_key) values
  ('org_admin', 'audit.read')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Is this member's scope the whole organisation?
-- ---------------------------------------------------------------------------
--
-- The audit trail is organisation-wide and cannot be filtered by property: an
-- entry carries the resource it touched, not the property that resource
-- belongs to, and inferring one from the other across every table would be
-- guesswork that fails silently.
--
-- So rather than show a property-scoped manager a filtered trail that is
-- quietly incomplete, or an unfiltered one that exposes the rest of the
-- organisation, the viewer refuses and says which it is. "Do not expose
-- organisation-wide records to property-scoped users" is the rule; this is the
-- test for it.

create or replace function app.has_organisation_wide_scope(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.memberships m
      join public.property_assignments pa on pa.membership_id = m.id
     where m.organisation_id = p_org
       and m.auth_user_id = auth.uid()
       and m.status = 'active'
       and pa.scope_type = 'organisation'
  );
$$;

grant execute on function app.has_organisation_wide_scope(uuid)
  to propertyos_app, propertyos_worker;

-- Reading one record's own history means filtering by resource WITHIN an
-- organisation, which the existing resource index cannot serve on its own.
create index audit_events_org_resource_idx
  on audit_events (organisation_id, resource_type, resource_id, occurred_at desc);

-- The trail is read by action and by actor often enough to be worth an index:
-- "what did this person do" and "every refund approval" are the two questions
-- a dispute actually starts from.
create index audit_events_org_action_idx
  on audit_events (organisation_id, action, occurred_at desc);
create index audit_events_org_actor_idx
  on audit_events (organisation_id, actor_user_id, occurred_at desc);
