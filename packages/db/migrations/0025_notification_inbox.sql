-- 0025_notification_inbox.sql
-- Makes the existing notifications table usable as a per-user inbox.
--
-- Two gaps. A recipient could READ their own notices (notifications_recipient_select)
-- but not mark one read, because the only update policy required organisation
-- membership — which a resident does not have, so the resident inbox would have
-- been permanently unread. And a notice had nowhere to point, so "your lease
-- agreement is ready" could not take anyone to it.

alter table notifications
  add column if not exists link_path text,
  add column if not exists title text;

-- A recipient may mark their OWN notice read, and nothing else about it. The
-- with-check repeats the qualifier so a row cannot be re-addressed to someone
-- else on the way through.
create policy notifications_recipient_update on notifications
  for update
  using (recipient_user_id = auth.uid())
  with check (recipient_user_id = auth.uid());

create index if not exists notifications_recipient_unread_idx
  on notifications (recipient_user_id, created_at desc)
  where read_at is null;

select app.assert_table_privileges();
