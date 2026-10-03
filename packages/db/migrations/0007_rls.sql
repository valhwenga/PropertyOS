-- 0007_rls.sql
-- Row Level Security.
--
-- Trust model:
--   * Every request-scoped connection authenticates as `propertyos_app`, which
--     is NOT the table owner and NOT a superuser, so RLS is always enforced.
--   * The only input to a policy is `auth.uid()`, resolved from the JWT claims
--     the server sets after verifying the session. An organisation_id arriving
--     in a URL or request body influences nothing: it is a filter, never a grant.
--   * The privileged (owner) connection exists only for migrations. It is never
--     reachable from the browser and never used to serve a request.
--   * Spike operators reach customer rows only through an unexpired, unrevoked
--     support session that the customer authorised, and only for SELECT.

-- ---------------------------------------------------------------------------
-- Baseline privileges
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema public
  to propertyos_app, propertyos_worker;
grant usage, select on all sequences in schema public
  to propertyos_app, propertyos_worker;

-- Reference data is read-only to the application roles.
revoke insert, update, delete on roles, permissions, role_permissions, plans,
  plan_entitlements, notification_templates, schema_migrations
  from propertyos_app, propertyos_worker;

-- Posted financial history is append-only even before RLS is considered.
revoke update, delete on journals, journal_lines from propertyos_app, propertyos_worker;
revoke delete on charge_documents, charge_lines, receipts, payment_allocations,
  deposit_events, audit_events from propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Helper: standard organisation-scoped policies
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  org_scoped text[] := array[
    'portfolios', 'parties', 'property_ownerships', 'owner_links',
    'resident_profiles', 'emergency_contacts', 'lease_parties',
    'occupancy_intervals', 'portal_links',
    'financial_books', 'accounts', 'period_locks', 'journals', 'journal_lines',
    'charge_schedules', 'billing_runs', 'charge_documents', 'charge_lines',
    'payment_evidence', 'receipts', 'payment_allocations',
    'deposit_accounts', 'deposit_events',
    'documents', 'document_access_grants',
    'bank_accounts', 'bank_imports', 'bank_transactions',
    'vendors', 'expenses',
    'maintenance_ticket_events', 'maintenance_comments', 'maintenance_attachments',
    'work_orders', 'maintenance_quotes', 'contractor_assignments',
    'inspection_templates', 'inspection_items', 'inspection_photos',
    'inspection_acknowledgements',
    'notifications', 'delivery_attempts',
    'outbox_events', 'jobs', 'idempotency_keys', 'audit_events',
    'property_assignments'
  ];
begin
  foreach t in array org_scoped loop
    execute format('alter table %I enable row level security', t);

    -- Read: an active member of the organisation, or an authorised support session.
    execute format($f$
      create policy %1$s_select on %1$I
        for select
        using (
          app.is_org_member(organisation_id)
          or app.has_support_access(organisation_id)
        )
    $f$, t);

    -- Write: active members only. Support sessions are read-only by design.
    execute format($f$
      create policy %1$s_insert on %1$I
        for insert
        with check (app.is_org_member(organisation_id))
    $f$, t);

    execute format($f$
      create policy %1$s_update on %1$I
        for update
        using (app.is_org_member(organisation_id))
        with check (app.is_org_member(organisation_id))
    $f$, t);

    execute format($f$
      create policy %1$s_delete on %1$I
        for delete
        using (app.is_org_member(organisation_id))
    $f$, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Property-scoped tables
-- ---------------------------------------------------------------------------
-- Organisation membership alone is not enough: the member must also hold a
-- matching scope assignment. "Property manager requests an unassigned property:
-- denied even within the same organisation."
do $$
declare
  rec record;
  scoped jsonb := '[
    {"table": "properties",           "col": "id"},
    {"table": "buildings",            "col": "property_id"},
    {"table": "units",                "col": "property_id"},
    {"table": "maintenance_tickets",  "col": "property_id"},
    {"table": "inspections",          "col": "property_id"}
  ]'::jsonb;
begin
  for rec in select value ->> 'table' as t, value ->> 'col' as c from jsonb_array_elements(scoped) loop
    execute format('alter table %I enable row level security', rec.t);

    execute format($f$
      create policy %1$s_select on %1$I
        for select
        using (
          (app.is_org_member(organisation_id) and app.can_access_property(organisation_id, %2$I))
          or app.has_support_access(organisation_id)
        )
    $f$, rec.t, rec.c);

    execute format($f$
      create policy %1$s_insert on %1$I
        for insert
        with check (
          app.is_org_member(organisation_id)
          and app.can_access_property(organisation_id, %2$I)
        )
    $f$, rec.t, rec.c);

    execute format($f$
      create policy %1$s_update on %1$I
        for update
        using (
          app.is_org_member(organisation_id)
          and app.can_access_property(organisation_id, %2$I)
        )
        with check (
          app.is_org_member(organisation_id)
          and app.can_access_property(organisation_id, %2$I)
        )
    $f$, rec.t, rec.c);

    execute format($f$
      create policy %1$s_delete on %1$I
        for delete
        using (
          app.is_org_member(organisation_id)
          and app.can_access_property(organisation_id, %2$I)
        )
    $f$, rec.t, rec.c);
  end loop;
end
$$;

-- Units also need a policy for the property-scope check via property_id, which
-- the loop above already supplied. unit_availability hangs off a unit.
alter table unit_availability enable row level security;
create policy unit_availability_select on unit_availability
  for select using (
    app.has_support_access(organisation_id)
    or (app.is_org_member(organisation_id) and exists (
      select 1 from units u
      where u.id = unit_availability.unit_id
        and u.organisation_id = unit_availability.organisation_id
        and app.can_access_property(u.organisation_id, u.property_id)
    ))
  );
create policy unit_availability_write on unit_availability
  for all
  using (
    app.is_org_member(organisation_id) and exists (
      select 1 from units u
      where u.id = unit_availability.unit_id
        and u.organisation_id = unit_availability.organisation_id
        and app.can_access_property(u.organisation_id, u.property_id)
    )
  )
  with check (
    app.is_org_member(organisation_id) and exists (
      select 1 from units u
      where u.id = unit_availability.unit_id
        and u.organisation_id = unit_availability.organisation_id
        and app.can_access_property(u.organisation_id, u.property_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Leases: property scope for operators, portal link for residents
-- ---------------------------------------------------------------------------
alter table leases enable row level security;

create policy leases_operator_select on leases
  for select
  using (
    (app.is_org_member(organisation_id) and app.can_access_property(organisation_id, property_id))
    or app.has_support_access(organisation_id)
  );

-- "Resident changes a lease ID in a request: only authorised lease access
-- succeeds." The resident's reachable set comes from their own portal links.
create policy leases_resident_select on leases
  for select
  using (app.can_access_lease_as_resident(id));

create policy leases_operator_insert on leases
  for insert
  with check (
    app.is_org_member(organisation_id)
    and app.can_access_property(organisation_id, property_id)
  );

create policy leases_operator_update on leases
  for update
  using (
    app.is_org_member(organisation_id)
    and app.can_access_property(organisation_id, property_id)
  )
  with check (
    app.is_org_member(organisation_id)
    and app.can_access_property(organisation_id, property_id)
  );

-- ---------------------------------------------------------------------------
-- Resident read access to their own records
-- ---------------------------------------------------------------------------
-- These are additive SELECT policies (PostgreSQL ORs permissive policies
-- together), each one anchored to a lease the resident actually holds.

create policy charge_documents_resident_select on charge_documents
  for select using (app.can_access_lease_as_resident(lease_id));

create policy charge_lines_resident_select on charge_lines
  for select using (app.can_access_lease_as_resident(lease_id));

create policy receipts_resident_select on receipts
  for select using (lease_id is not null and app.can_access_lease_as_resident(lease_id));

create policy payment_allocations_resident_select on payment_allocations
  for select using (
    exists (
      select 1 from charge_lines cl
      where cl.id = payment_allocations.charge_line_id
        and app.can_access_lease_as_resident(cl.lease_id)
    )
  );

create policy payment_evidence_resident_select on payment_evidence
  for select using (app.can_access_lease_as_resident(lease_id));

-- A resident may submit their own proof of payment against their own lease.
create policy payment_evidence_resident_insert on payment_evidence
  for insert with check (
    app.can_access_lease_as_resident(lease_id)
    and submitted_by = auth.uid()
    and status = 'submitted'
    and receipt_id is null
  );

create policy deposit_accounts_resident_select on deposit_accounts
  for select using (app.can_access_lease_as_resident(lease_id));

create policy deposit_events_resident_select on deposit_events
  for select using (
    exists (
      select 1 from deposit_accounts da
      where da.id = deposit_events.deposit_account_id
        and app.can_access_lease_as_resident(da.lease_id)
    )
  );

create policy lease_parties_resident_select on lease_parties
  for select using (app.can_access_lease_as_resident(lease_id));

-- A resident sees their OWN profile only, never a co-resident's.
create policy resident_profiles_self_select on resident_profiles
  for select using (
    exists (
      select 1 from portal_links pl
      where pl.resident_id = resident_profiles.id
        and pl.auth_user_id = auth.uid()
        and pl.status = 'active'
        and pl.revoked_at is null
        and pl.expires_at > now()
    )
  );

-- Documents explicitly shared with the resident, on a lease they hold, and only
-- once the file has cleared quarantine.
create policy documents_resident_select on documents
  for select using (
    visibility = 'resident_shared'
    and quarantined = false
    and scan_status <> 'infected'
    and deleted_at is null
    and lease_id is not null
    and app.can_access_lease_as_resident(lease_id)
  );

-- Maintenance: a resident sees tickets on their own lease, and only the comments
-- and attachments marked resident visible.
create policy maintenance_tickets_resident_select on maintenance_tickets
  for select using (lease_id is not null and app.can_access_lease_as_resident(lease_id));

create policy maintenance_tickets_resident_insert on maintenance_tickets
  for insert with check (
    lease_id is not null
    and app.can_access_lease_as_resident(lease_id)
    and status = 'submitted'
  );

create policy maintenance_comments_resident_select on maintenance_comments
  for select using (
    audience = 'resident_visible'
    and exists (
      select 1 from maintenance_tickets t
      where t.id = maintenance_comments.ticket_id
        and t.lease_id is not null
        and app.can_access_lease_as_resident(t.lease_id)
    )
  );

create policy maintenance_comments_resident_insert on maintenance_comments
  for insert with check (
    audience = 'resident_visible'
    and author_user_id = auth.uid()
    and exists (
      select 1 from maintenance_tickets t
      where t.id = maintenance_comments.ticket_id
        and t.lease_id is not null
        and app.can_access_lease_as_resident(t.lease_id)
    )
  );

create policy maintenance_attachments_resident_select on maintenance_attachments
  for select using (
    audience = 'resident_visible'
    and exists (
      select 1 from maintenance_tickets t
      where t.id = maintenance_attachments.ticket_id
        and t.lease_id is not null
        and app.can_access_lease_as_resident(t.lease_id)
    )
  );

create policy inspections_resident_select on inspections
  for select using (
    lease_id is not null
    and status in ('finalised', 'acknowledged', 'disputed')
    and app.can_access_lease_as_resident(lease_id)
  );

create policy inspection_items_resident_select on inspection_items
  for select using (
    exists (
      select 1 from inspections i
      where i.id = inspection_items.inspection_id
        and i.lease_id is not null
        and i.status in ('finalised', 'acknowledged', 'disputed')
        and app.can_access_lease_as_resident(i.lease_id)
    )
  );

create policy notifications_recipient_select on notifications
  for select using (recipient_user_id = auth.uid());

create policy portal_links_self_select on portal_links
  for select using (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Access tables
-- ---------------------------------------------------------------------------
alter table organisations enable row level security;
create policy organisations_select on organisations
  for select using (app.is_org_member(id) or app.has_support_access(id));
create policy organisations_update on organisations
  for update
  using (app.has_permission(id, 'organisation.settings.manage'))
  with check (app.has_permission(id, 'organisation.settings.manage'));

alter table memberships enable row level security;
-- A member sees the membership list of their own organisation; everyone always
-- sees their own membership row (needed to bootstrap organisation selection).
create policy memberships_select on memberships
  for select using (
    auth_user_id = auth.uid()
    or app.is_org_member(organisation_id)
    or app.has_support_access(organisation_id)
  );
create policy memberships_manage on memberships
  for all
  using (app.has_permission(organisation_id, 'membership.manage'))
  with check (app.has_permission(organisation_id, 'membership.manage'));

alter table membership_roles enable row level security;
create policy membership_roles_select on membership_roles
  for select using (
    exists (
      select 1 from memberships m
      where m.id = membership_roles.membership_id
        and (m.auth_user_id = auth.uid()
             or app.is_org_member(m.organisation_id)
             or app.has_support_access(m.organisation_id))
    )
  );
create policy membership_roles_manage on membership_roles
  for all
  using (
    exists (
      select 1 from memberships m
      where m.id = membership_roles.membership_id
        and app.has_permission(m.organisation_id, 'membership.manage')
    )
  )
  with check (
    exists (
      select 1 from memberships m
      where m.id = membership_roles.membership_id
        and app.has_permission(m.organisation_id, 'membership.manage')
    )
  );

alter table user_profiles enable row level security;
create policy user_profiles_self on user_profiles
  for select using (auth_user_id = auth.uid());
create policy user_profiles_self_update on user_profiles
  for update using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());
-- Colleagues in a shared organisation are visible to each other.
create policy user_profiles_colleagues on user_profiles
  for select using (
    exists (
      select 1 from memberships mine
      join memberships theirs on theirs.organisation_id = mine.organisation_id
      where mine.auth_user_id = auth.uid()
        and mine.status = 'active'
        and theirs.auth_user_id = user_profiles.auth_user_id
    )
  );

alter table support_sessions enable row level security;
create policy support_sessions_select on support_sessions
  for select using (
    operator_user_id = auth.uid() or app.is_org_member(organisation_id)
  );
create policy support_sessions_org_revoke on support_sessions
  for update
  using (app.has_permission(organisation_id, 'support.access.manage'))
  with check (app.has_permission(organisation_id, 'support.access.manage'));

alter table subscriptions enable row level security;
create policy subscriptions_select on subscriptions
  for select using (app.is_org_member(organisation_id) or app.has_support_access(organisation_id));

-- Reference tables are world-readable to authenticated roles and not writable.
alter table roles enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;
alter table plans enable row level security;
alter table plan_entitlements enable row level security;
alter table notification_templates enable row level security;
create policy roles_read on roles for select using (true);
create policy permissions_read on permissions for select using (true);
create policy role_permissions_read on role_permissions for select using (true);
create policy plans_read on plans for select using (true);
create policy plan_entitlements_read on plan_entitlements for select using (true);
create policy notification_templates_read on notification_templates for select using (true);

-- Infrastructure tables with no organisation column.
alter table job_attempts enable row level security;
create policy job_attempts_none on job_attempts for select using (false);
alter table webhook_events enable row level security;
create policy webhook_events_none on webhook_events for select using (false);
alter table schema_migrations enable row level security;
create policy schema_migrations_read on schema_migrations for select using (true);

-- Audit history is never rewritten by the application.
revoke update on audit_events from propertyos_app, propertyos_worker;
