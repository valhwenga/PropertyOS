/**
 * Sends one real message, and says exactly what came back.
 *
 *   pnpm email:test somebody@example.com
 *
 * The preflight tells you the configuration is plausible and the key works.
 * This is the one that tells you a message arrives, which is a different
 * question and the only one that matters on the day: a verified key with an
 * unverified sending domain, a `from` address that does not match the domain,
 * or an SPF record that has not propagated all look identical until something
 * actually goes out.
 *
 * It prints the provider's own answer verbatim, including the message id, so
 * the send can be found in the provider's dashboard. Nothing is written to the
 * database: this is not a notification, it is a test of the pipe.
 */
import { resolveEmailAdapter, SinkEmailAdapter } from '@propertyos/integrations';

const to = process.argv[2];

if (!to || !to.includes('@')) {
  process.stderr.write(
    'Usage: pnpm email:test <address>\n\n'
    + 'Sends one message through whatever EMAIL_PROVIDER is configured, and reports\n'
    + 'the provider\'s answer. Use an address you can actually read.\n',
  );
  process.exit(2);
}

const adapter = resolveEmailAdapter();

if (adapter instanceof SinkEmailAdapter) {
  // Deliberately an error exit: somebody running this wants to know whether
  // mail works, and "the sink took it" is not a yes.
  process.stderr.write(
    `Nothing was sent. The sink is in use:\n  ${adapter.reason}\n\n`
    + 'For Resend, set in .env.local:\n'
    + '  EMAIL_PROVIDER=resend\n'
    + '  RESEND_API_KEY=re_...\n'
    + '  EMAIL_FROM="Spike <no-reply@your-verified-domain>"\n',
  );
  process.exit(1);
}

const stamp = new Date().toISOString();
const outcome = await adapter.send({
  to,
  subject: `Spike PropertyOS test message — ${stamp}`,
  body: [
    'This is a test message from Spike PropertyOS.',
    '',
    `Sent at ${stamp} through the ${adapter.name} adapter.`,
    '',
    'If you are reading this, outbound email works: the provider accepted the',
    'message, the sending domain resolved, and it reached an inbox rather than',
    'a spam folder. That last part is worth checking — look at which folder',
    'this landed in.',
    '',
    'Nothing was recorded against any customer; this message is not a',
    'notification and does not appear in anybody\'s inbox inside the product.',
  ].join('\n'),
  idempotencyKey: `email-test-${stamp}`,
});

if (outcome.status === 'sent') {
  process.stdout.write(
    `Sent via ${outcome.provider}.\n`
    + `  message id: ${outcome.providerMessageId}\n\n`
    + 'The provider has accepted responsibility for it. Check the inbox — and the\n'
    + 'spam folder, which is where unauthenticated mail lands.\n',
  );
  process.exit(0);
}

if (outcome.status === 'development_sink') {
  process.stderr.write(`Nothing was sent: ${outcome.reason}\n`);
  process.exit(1);
}

process.stderr.write(
  `NOT sent. ${outcome.provider} said:\n  ${outcome.error}\n`
  + (outcome.retryAfterSeconds !== undefined
    ? `\nThis is a wait-and-retry answer rather than a refusal (about `
      + `${outcome.retryAfterSeconds}s).\n`
    : ''),
);
process.exit(1);
