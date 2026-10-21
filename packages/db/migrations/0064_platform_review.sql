-- ---------------------------------------------------------------------------
-- 0064  A Spike operator can review Spike's own actions, and nothing further
-- ---------------------------------------------------------------------------
--
-- Two reads the platform console needs and does not have. Both are about
-- SPIKE's conduct rather than a customer's records, which is the line this
-- schema draws everywhere else and draws again here.
--
--   1. Support sessions. `support_sessions_select` shows an operator only the
--      sessions they opened themselves. So the console's "2 support sessions
--      currently open" actually means "2 of mine", and the question an operator
--      most needs answered — is anybody at Spike inside this customer's account
--      right now — cannot be asked. The row holds an organisation, an operator,
--      a reason, two timestamps and a read-only flag: Spike's own metadata, with
--      no customer record reachable through any column of it.
--
--   2. Spike's own staff names. `user_profiles` is readable by yourself and by
--      colleagues you share a membership with, and an operator is a member of
--      nothing — so a session or a plan change made by a COLLEAGUE renders
--      without a name, and a review that cannot name who acted is not a review.
--      Widened to Spike's own staff only: the subject row must itself be a
--      platform operator. A customer's profile stays as closed as before.
--
--   3. Platform actions in the audit log. `audit_events_platform_own_select`
--      shows an operator only the entries they wrote, so a plan change or a
--      suspension by a colleague is invisible to the person asked about it
--      later. This grants `platform.%` actions only. Those entries are written
--      BY this module and their before/after values are plan keys and account
--      statuses; the policy cannot be widened by writing a customer's data into
--      one, because an operator cannot write a customer row at all.
--
-- What deliberately does NOT change: every other audit entry stays unreadable
-- to Spike, and reaching a customer's actual records still requires an
-- authorised, time-limited, audited support session. A platform operator gains
-- the ability to review Spike, not the customer.

create policy support_sessions_platform_select on support_sessions
  for select
  using (app.is_platform_operator());

comment on policy support_sessions_platform_select on support_sessions is
  'A Spike operator sees every support session, including colleagues'' — the '
  'row is Spike''s own metadata and no customer record is reachable through it.';

create policy user_profiles_platform_peer_select on user_profiles
  for select
  using (is_platform_operator and app.is_platform_operator());

comment on policy user_profiles_platform_peer_select on user_profiles is
  'A Spike operator sees other Spike operators'' names, so an audited platform '
  'action can be attributed. Customer profiles are unaffected.';

create policy audit_events_platform_select on audit_events
  for select
  using (app.is_platform_operator() and action like 'platform.%');

comment on policy audit_events_platform_select on audit_events is
  'A Spike operator sees platform.* audit entries only: plan changes, account '
  'status changes and support sessions. Customer activity remains closed to '
  'them with or without a support session.';

select app.assert_table_privileges();
