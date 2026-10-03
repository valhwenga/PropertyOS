-- 0012_inspection_response_sync.sql
-- A resident must be able to acknowledge or dispute an inspection, and that
-- outcome must be visible on the inspection itself rather than buried in a child
-- row. But residents have no write access to `inspections`, and widening that
-- policy would let them touch an inspector's record.
--
-- This function is the narrow alternative. It takes NO caller-supplied status:
-- it re-derives the inspection's state from the acknowledgement rows that
-- already exist and are already governed by their own RLS policy. The worst a
-- caller can do is recompute a value from data they were permitted to write.

create or replace function app.sync_inspection_response_status(p_inspection uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease   uuid;
  v_status  text;
  v_derived text;
begin
  select i.lease_id, i.status::text into v_lease, v_status
  from public.inspections i
  where i.id = p_inspection;

  if v_lease is null then
    raise exception 'inspection not found' using errcode = 'P0002';
  end if;

  -- The caller must be either an active member of the owning organisation or a
  -- resident holding a live portal link to this inspection's lease.
  if not (
    app.can_access_lease_as_resident(v_lease)
    or exists (
      select 1 from public.inspections i
      where i.id = p_inspection and app.is_org_member(i.organisation_id)
    )
  ) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Only a finalised inspection can move; a draft or superseded one is untouched.
  if v_status not in ('finalised', 'acknowledged', 'disputed') then
    return v_status;
  end if;

  -- A single outstanding dispute keeps the whole inspection in dispute.
  select case
           when bool_or(a.response = 'disputed') then 'disputed'
           when count(*) > 0 then 'acknowledged'
           else 'finalised'
         end
    into v_derived
  from public.inspection_acknowledgements a
  where a.inspection_id = p_inspection;

  update public.inspections set status = v_derived::text
  where id = p_inspection and status::text <> v_derived;

  return v_derived;
end;
$$;

grant execute on function app.sync_inspection_response_status(uuid)
  to propertyos_app, propertyos_worker;
