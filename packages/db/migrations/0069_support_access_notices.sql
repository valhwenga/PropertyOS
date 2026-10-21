-- ---------------------------------------------------------------------------
-- 0069  The customer is told when Spike asks, and when Spike comes in
-- ---------------------------------------------------------------------------
--
-- Support access now needs the customer's approval (0065), and the request
-- appears on their support-access screen — which only helps somebody who
-- happens to look at that screen. These two in-app notices put it in front of
-- them: one when an operator asks, one when a session is admitted by a window
-- they opened earlier.
--
-- Deliberately in-app rather than email. No email provider is configured in
-- this build, so an email notice would be recorded as undelivered and the
-- person would learn nothing; the inbox is the channel that actually works
-- today. There is no notice for the customer APPROVING a session, because
-- telling somebody what they themselves just clicked is noise.

insert into notification_templates (key, channel, subject, body) values
  (
    'support.access.requested',
    'in_app',
    'Spike support is asking to read your records',
    'A Spike support operator has asked for read-only access to your '
      || 'organisation''s records. Nothing is visible to them until an '
      || 'administrator approves it. Open Settings → Spike support access to '
      || 'see who asked, what for, and to approve or decline.'
  ),
  (
    'support.access.opened',
    'in_app',
    'Spike support opened your account',
    'A Spike support operator opened a read-only session using the access '
      || 'window your organisation left open. It is time limited, every record '
      || 'they open is recorded against it, and you can end it at any time '
      || 'under Settings → Spike support access.'
  );
