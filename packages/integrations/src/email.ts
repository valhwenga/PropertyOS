/**
 * Email adapter.
 *
 * Two implementations, chosen by configuration:
 *
 *  - `SmtpEmailAdapter`  — real delivery through a configured SMTP provider.
 *  - `SinkEmailAdapter`  — development only. It records the message and returns
 *    `development_sink`, which is a DISTINCT state from `sent`.
 *
 * The sink exists so that a missing provider never blocks local development, but
 * it must never be mistaken for delivery: nothing in this module returns
 * `sent` unless a provider acknowledged the message. A notification row written
 * by the sink is reported in the UI as "not delivered — no email provider is
 * configured", with the configuration steps.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  templateKey?: string;
}

export type EmailOutcome =
  | { status: 'sent'; provider: string; providerMessageId: string }
  | { status: 'development_sink'; provider: 'sink'; reason: string }
  | { status: 'failed'; provider: string; error: string };

import { sendViaSmtp, type SmtpConfig } from './smtp';

export interface EmailAdapter {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailOutcome>;
}

export class SinkEmailAdapter implements EmailAdapter {
  readonly name = 'sink';
  readonly captured: EmailMessage[] = [];
  constructor(private readonly reason: string) {}

  async send(message: EmailMessage): Promise<EmailOutcome> {
    this.captured.push(message);
    // Deliberately logged as not-delivered.
    return { status: 'development_sink', provider: 'sink', reason: this.reason };
  }
}

export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = 'smtp';
  constructor(private readonly config: SmtpConfig) {}

  /**
   * Returns `sent` ONLY when the server issued a 2xx to the final `.` of the
   * DATA block — that is, when the provider accepted responsibility for the
   * message. Any other outcome is `failed`, with the server's own words.
   */
  async send(message: EmailMessage): Promise<EmailOutcome> {
    try {
      const accepted = await sendViaSmtp(this.config, {
        to: message.to,
        subject: message.subject,
        body: message.body,
      });
      return {
        status: 'sent',
        provider: 'smtp',
        // The server's queue id where it supplies one, else our Message-ID.
        providerMessageId: accepted.response.replace(/^250[ -]/, '').trim() || accepted.messageId,
      };
    } catch (error) {
      return {
        status: 'failed',
        provider: 'smtp',
        error: error instanceof Error ? error.message : 'The message could not be sent.',
      };
    }
  }
}

/**
 * Resolves the adapter from the environment.
 * Missing credentials fall back to the sink WITH AN EXPLICIT REASON, never to a
 * silent success.
 */
export function resolveEmailAdapter(env: NodeJS.ProcessEnv = process.env): EmailAdapter {
  if (env.EMAIL_PROVIDER !== 'smtp') {
    return new SinkEmailAdapter(
      'EMAIL_PROVIDER is not set to "smtp". Messages are recorded locally and NOT delivered. ' +
        'Set EMAIL_PROVIDER, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM to enable delivery.',
    );
  }
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM']
    .filter((key) => !env[key]);
  if (missing.length > 0) {
    return new SinkEmailAdapter(
      `EMAIL_PROVIDER is "smtp" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Messages are recorded locally and NOT delivered.',
    );
  }
  const port = Number(env.SMTP_PORT);
  return new SmtpEmailAdapter({
    host: env.SMTP_HOST!,
    port,
    user: env.SMTP_USER!,
    password: env.SMTP_PASSWORD!,
    from: env.EMAIL_FROM!,
    // Port 465 is implicit TLS; everything else attempts STARTTLS.
    secure: port === 465,
    rejectUnauthorized: env.SMTP_ALLOW_SELF_SIGNED !== 'true',
  });
}
