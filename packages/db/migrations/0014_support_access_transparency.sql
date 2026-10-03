-- 0014_support_access_transparency.sql
-- A customer must be able to see WHO at Spike accessed their data, not just
-- that somebody did. Without this the support access log reads "an operator",
-- which is not accountability.
--
-- This is the narrowest grant that achieves it: a member of an organisation may
-- read the profile of a platform operator who holds, or has held, a support
-- session for THAT organisation. It exposes nothing about Spike staff who never
-- touched their account.

create policy user_profiles_support_operator_select on user_profiles
  for select
  using (
    user_profiles.is_platform_operator
    and exists (
      select 1 from support_sessions s
      where s.operator_user_id = user_profiles.auth_user_id
        and app.is_org_member(s.organisation_id)
    )
  );

comment on policy user_profiles_support_operator_select on user_profiles is
  'Lets a customer see the name of the Spike operator who accessed their account. Scoped to operators who actually hold a support session for an organisation the caller belongs to.';
