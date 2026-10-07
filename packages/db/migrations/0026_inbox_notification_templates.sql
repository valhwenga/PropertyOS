-- 0026_inbox_notification_templates.sql
-- Registers the in-app notices the product posts.
--
-- notifications.template_key is a foreign key into notification_templates, so
-- every notice must name a registered kind. That is deliberate: it keeps the
-- set of things the product says to people enumerable and reviewable, rather
-- than letting any caller invent wording at the point of sending.
--
-- The subject and body here are the DEFAULT wording. A caller that has the
-- specifics — which lease, which template, which applicant — passes its own
-- title and body, which is why the stored text reads as a fallback.

insert into notification_templates (key, channel, subject, body, version) values
  ('lease.agreement.shared', 'in_app',
   'Your lease agreement is available',
   'Your landlord has shared your lease agreement with you. You can read and download it from your documents.',
   1),
  ('lease.template.updated', 'in_app',
   'A Spike lease template was updated',
   'A template you copied has a newer version from Spike. Your own wording is unchanged; review the new version and decide whether to adopt it.',
   1),
  ('lease.terminated', 'in_app',
   'A lease was ended',
   'A lease has been ended. The reason and the effective date are recorded on the lease.',
   1),
  ('lease.extended', 'in_app',
   'A lease was extended',
   'A lease has been extended. The new end date and the reason are recorded on the lease.',
   1),
  ('rental.application.received', 'in_app',
   'New rental application',
   'Someone applied through your application link. Review it before contacting them.',
   1)
on conflict (key) do nothing;
