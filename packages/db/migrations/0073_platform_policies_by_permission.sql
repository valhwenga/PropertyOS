-- ---------------------------------------------------------------------------
-- 0073  The database agrees with the console about who may do what
-- ---------------------------------------------------------------------------
--
-- 0072 gave Spike's operators named roles and the code now checks them. On its
-- own that is a check in one place: every platform WRITE policy still said
-- `app.is_platform_operator()`, so the database would happily accept a write
-- from an operator holding only the read-only role if any path reached it
-- without the domain function — which is exactly the arrangement the rest of
-- this schema refuses to rely on for customers.
--
-- So the platform policies are restated in terms of the permission they are
-- really about. Reads stay broad on purpose: an operator in the console may
-- see the accounts, and the sensitive reads here are already counts-only
-- (customer records need a support session, which this does not change).
-- Writes become specific.
--
-- `app.platform_permission` is built on `app.is_platform_operator()`, so every
-- policy below still carries the second-factor requirement without repeating
-- it.

-- --------------------------------------------------- the account itself
drop policy organisations_platform_update on organisations;
create policy organisations_platform_update on organisations
  for update
  using (app.platform_permission('platform.customers.status')
         or app.platform_permission('platform.customers.plan'))
  with check (app.platform_permission('platform.customers.status')
              or app.platform_permission('platform.customers.plan'));

comment on policy organisations_platform_update on organisations is
  'Suspending an account and changing its plan are the two platform writes '
  'that touch this row; both are named permissions rather than operator status.';

-- --------------------------------------------------- what they are charged
drop policy subscriptions_platform_update on subscriptions;
create policy subscriptions_platform_update on subscriptions
  for update
  using (app.platform_permission('platform.customers.plan'))
  with check (app.platform_permission('platform.customers.plan'));

drop policy subscriptions_platform_insert on subscriptions;
create policy subscriptions_platform_insert on subscriptions
  for insert
  with check (app.platform_permission('platform.customers.provision')
              or app.platform_permission('platform.customers.plan'));

drop policy subscription_invoices_platform_insert on subscription_invoices;
create policy subscription_invoices_platform_insert on subscription_invoices
  for insert with check (app.platform_permission('platform.billing.manage'));

drop policy subscription_invoices_platform_update on subscription_invoices;
create policy subscription_invoices_platform_update on subscription_invoices
  for update
  using (app.platform_permission('platform.billing.manage'))
  with check (app.platform_permission('platform.billing.manage'));

drop policy subscription_invoice_lines_platform_insert on subscription_invoice_lines;
create policy subscription_invoice_lines_platform_insert on subscription_invoice_lines
  for insert with check (app.platform_permission('platform.billing.manage'));

drop policy platform_billing_settings_platform_all on platform_billing_settings;
create policy platform_billing_settings_select on platform_billing_settings
  for select using (app.is_platform_operator());
create policy platform_billing_settings_update on platform_billing_settings
  for update
  using (app.platform_permission('platform.billing.manage'))
  with check (app.platform_permission('platform.billing.manage'));

-- --------------------------------------------------- asking for access
--
-- The two conditions beside the permission are the control, not decoration,
-- and the first draft of this migration dropped them: `read_only = true` is
-- what makes a support session incapable of writing, and
-- `operator_user_id = auth.uid()` is what stops an operator opening a session
-- in a colleague's name — asking on their behalf and reading under their
-- identity. The isolation tests caught both, which is why they are spelled out
-- again here rather than left to the reader of 0013.
drop policy support_sessions_platform_insert on support_sessions;
create policy support_sessions_platform_insert on support_sessions
  for insert
  with check (
    app.platform_permission('platform.support.request')
    and operator_user_id = auth.uid()
    and read_only = true
  );

-- An operator may revoke the session they opened. What they may NOT do is
-- approve it: that is `app.support_session_approval_guard()` from 0066, a
-- trigger, because a policy cannot see which column changed.
drop policy support_sessions_platform_update on support_sessions;
create policy support_sessions_platform_update on support_sessions
  for update
  using (app.platform_permission('platform.support.request')
         and operator_user_id = auth.uid())
  with check (app.platform_permission('platform.support.request')
              and operator_user_id = auth.uid());

-- --------------------------------------------------- the wording customers inherit
drop policy system_lease_templates_write on system_lease_templates;
create policy system_lease_templates_write on system_lease_templates
  for all
  using (app.platform_permission('platform.templates.manage'))
  with check (app.platform_permission('platform.templates.manage'));

drop policy system_lease_template_versions_write on system_lease_template_versions;
create policy system_lease_template_versions_write on system_lease_template_versions
  for all
  using (app.platform_permission('platform.templates.manage'))
  with check (app.platform_permission('platform.templates.manage'));

-- --------------------------------------------------- requests for an account
drop policy signup_requests_platform_all on signup_requests;
create policy signup_requests_platform_select on signup_requests
  for select using (app.is_platform_operator());
create policy signup_requests_platform_update on signup_requests
  for update
  using (app.platform_permission('platform.customers.provision'))
  with check (app.platform_permission('platform.customers.provision'));
