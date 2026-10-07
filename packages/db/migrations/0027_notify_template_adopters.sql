-- 0027_notify_template_adopters.sql
-- Tells the customers who adopted a Spike template that a new version exists.
--
-- This cannot be done in the caller's own context. A Spike platform operator
-- has NO read access to customer content — lease_templates_select requires
-- organisation membership or an authorised support session — so a query run as
-- the operator finds no adopters and the notice silently never arrives. That
-- restriction is correct and is not being relaxed.
--
-- Instead the database does the work and reports only COUNTS. The operator
-- learns that four people across two customers were told; they do not learn
-- which customers, which people, or that any particular organisation uses the
-- template at all. Acting on a customer's behalf is not the same as reading
-- their records, and only the former is granted here.

create or replace function app.notify_template_adopters(
  p_template_id uuid,
  p_version integer
)
returns table (organisations integer, people integer)
language plpgsql
security definer
-- Pinned: a SECURITY DEFINER function with a caller-controlled search_path is
-- an escalation waiting to happen.
set search_path = public, pg_catalog
as $$
declare
  v_name   text;
  v_marker text;
  v_orgs   integer := 0;
  v_people integer := 0;
begin
  -- Only a platform operator may trigger this. The function runs as its owner,
  -- so this check is the access control, not the policies.
  if not app.is_platform_operator() then
    raise exception 'Only a Spike operator can notify template adopters.'
      using errcode = 'insufficient_privilege';
  end if;

  select name into v_name from system_lease_templates where id = p_template_id;
  if v_name is null then
    return query select 0, 0;
    return;
  end if;
  v_marker := 'Spike template: ' || v_name;

  with recipients as (
    select distinct m.organisation_id, m.auth_user_id
      from lease_templates lt
      join memberships m
        on m.organisation_id = lt.organisation_id and m.status = 'active'
      join membership_roles mr on mr.membership_id = m.id
     where lt.source_note = v_marker
       and mr.role_key in ('org_admin', 'portfolio_manager')
  ), posted as (
    insert into notifications (
      organisation_id, template_key, channel, recipient_user_id,
      title, subject, body, link_path, status, provider, sent_at
    )
    select r.organisation_id, 'lease.template.updated', 'in_app', r.auth_user_id,
           format('Spike published v%s of "%s"', p_version, v_name),
           format('Spike published v%s of "%s"', p_version, v_name),
           'A template you copied has a newer version from Spike. Your own wording is '
           || 'unchanged and no agreement you have already generated is affected. Copy it '
           || 'again if you want the new version, then review and publish it yourself.',
           '/account/notifications', 'sent', 'in_app', now()
      from recipients r
    returning organisation_id
  )
  select count(distinct organisation_id)::integer, count(*)::integer
    into v_orgs, v_people
    from posted;

  return query select coalesce(v_orgs, 0), coalesce(v_people, 0);
end;
$$;

revoke all on function app.notify_template_adopters(uuid, integer) from public;
grant execute on function app.notify_template_adopters(uuid, integer) to propertyos_app;
