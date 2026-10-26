-- ---------------------------------------------------------------------------
-- 0075  What Spike has done, readable by Spike's reviewers
-- ---------------------------------------------------------------------------
--
-- `platform.audit.read` was named in 0072 and had no screen behind it, and the
-- reason it needed one has changed shape since: sessions can now CHANGE a
-- customer's records. So "what has Spike done inside our customers' data" went
-- from a question about reading to a question about writing, and the only
-- person who could answer it was the operator who did it —
-- `audit_events_platform_own_select` shows an operator their own actions, and
-- nothing showed a colleague's.
--
-- Migration 0064 settled this argument once already, for platform actions: a
-- review that cannot name who acted is not a review. The same sentence applies
-- to an action taken under a support session, more strongly.
--
-- Two policies, and the narrowness of the first is the whole point.

-- ---------------------------------------------------------------------------
-- Spike's conduct inside a customer's records
-- ---------------------------------------------------------------------------
--
-- `support_session_id is not null` is exactly the set of actions taken under a
-- support session, which 0074's trigger stamps automatically. It is therefore
-- Spike's own conduct and never the customer's: a landlord's staff changing
-- their own lease carries no session id and stays as invisible to Spike as it
-- has always been. The reviewer gets the actions of their colleagues, not a
-- window into the customers.
create policy audit_events_platform_support_select on audit_events
  for select
  using (
    app.platform_permission('platform.audit.read')
    and support_session_id is not null
  );

comment on policy audit_events_platform_support_select on audit_events is
  'Actions taken under a support session, for review by an operator holding '
  'platform.audit.read. Scoped by the session stamp, so it carries Spike''s '
  'own conduct and never a customer''s own staff.';

-- ---------------------------------------------------------------------------
-- And the platform trail, by permission rather than by status
-- ---------------------------------------------------------------------------
--
-- Unchanged in practice — every platform role carries `platform.audit.read` —
-- and correct in principle, which is the same reason 0073 restated the write
-- policies. An operator holding no role at all now reads nothing, which is
-- what holding no role should mean.
drop policy audit_events_platform_select on audit_events;
create policy audit_events_platform_select on audit_events
  for select
  using (
    app.platform_permission('platform.audit.read')
    and action like 'platform.%'
  );

-- `audit_events_platform_own_select` is deliberately left alone: seeing what
-- you yourself did is not a privilege to be withheld, and an operator whose
-- roles were just removed should still be able to account for their own work.
