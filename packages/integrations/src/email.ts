/**
 * Email adapter.
 *
 * Three implementations, chosen by configuration:
 *
 *  - `ResendEmailAdapter` — real delivery over HTTPS. The default choice for a
 *    deployment, because 443 is open where this product runs and 587 is not.
 *  - `SmtpEmailAdapter`  — real delivery through any configured SMTP provider.
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
  /**
   * A stable key for this message, so that a retry of something the provider
   * already accepted cannot send a second copy. The notification's own id.
   * Honoured by Resend; SMTP has no equivalent and ignores it.
   */
  idempotencyKey?: string;
  replyTo?: string;
}

export type EmailOutcome =
  | { status: 'sent'; provider: string; providerMessageId: string }
  | { status: 'development_sink'; provider: 'sink'; reason: string }
  /**
   * `retryAfterSeconds` separates "ask again shortly" from "this message is
   * not acceptable". A provider that rate-limits us, is briefly down, or
   * cannot be reached has not refused the message, and a caller that spends a
   * delivery attempt on it will eventually mark real mail as failed.
   */
  | { status: 'failed'; provider: string; error: string; retryAfterSeconds?: number };

import { sendViaSmtp, type SmtpConfig } from './smtp';
import { sendViaResend, type ResendConfig } from './resend';

export interface EmailAdapter {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailOutcome>;
}

export class SinkEmailAdapter implements EmailAdapter {
  readonly name = 'sink';
  readonly captured: EmailMessage[] = [];
  /** Why nothing will be delivered. Readable, because callers must be able to
   *  say so rather than guess: the preflight prints it, and the interface shows
   *  it beside an undelivered notification. */
  constructor(readonly reason: string) {}

  async send(message: EmailMessage): Promise<EmailOutcome> {
    this.captured.push(message);
    // Deliberately logged as not-delivered.
    return { status: 'development_sink', provider: 'sink', reason: this.reason };
  }
}

export class ResendEmailAdapter implements EmailAdapter {
  readonly name = 'resend';
  constructor(private readonly config: ResendConfig) {}

  /**
   * `sent` only when Resend answered 2xx AND gave a message id to find it
   * again by. Everything else — a refusal, a rate limit, an unreachable
   * provider, a 2xx we could not read an id out of — is `failed`, with the
   * provider's own words and, where it is worth asking again, how long to
   * wait.
   */
  async send(message: EmailMessage): Promise<EmailOutcome> {
    const result = await sendViaResend(this.config, {
      to: message.to,
      subject: message.subject,
      body: message.body,
      idempotencyKey: message.idempotencyKey,
      replyTo: message.replyTo,
    });

    if (result.accepted) {
      return { status: 'sent', provider: 'resend', providerMessageId: result.id };
    }
    return {
      status: 'failed',
      provider: 'resend',
      error: result.error,
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    };
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
 *
 * Missing credentials fall back to the sink WITH AN EXPLICIT REASON, never to a
 * silent success — and the reason names what to set, because the person reading
 * it on the console is usually the person who has to fix it.
 */
export function resolveEmailAdapter(env: NodeJS.ProcessEnv = process.env): EmailAdapter {
  const provider = env.EMAIL_PROVIDER;

  if (provider === 'resend') {
    const missing = ['RESEND_API_KEY', 'EMAIL_FROM'].filter((key) => !env[key]);
    if (missing.length > 0) {
      return new SinkEmailAdapter(
        `EMAIL_PROVIDER is "resend" but ${missing.join(' and ')} ${
          missing.length === 1 ? 'is' : 'are'} not set. `
          + 'Messages are recorded locally and NOT delivered.',
      );
    }
    return new ResendEmailAdapter({
      apiKey: env.RESEND_API_KEY!,
      from: env.EMAIL_FROM!,
      // Only ever set by the tests, which point it at a local stand-in.
      ...(env.RESEND_API_URL ? { baseUrl: env.RESEND_API_URL } : {}),
    });
  }

  if (provider !== 'smtp') {
    return new SinkEmailAdapter(
      'EMAIL_PROVIDER is set to neither "resend" nor "smtp". Messages are recorded locally '
        + 'and NOT delivered. Set EMAIL_PROVIDER=resend with RESEND_API_KEY and EMAIL_FROM, '
        + 'or EMAIL_PROVIDER=smtp with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and '
        + 'EMAIL_FROM.',
    );
  }

  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM']
    .filter((key) => !env[key]);
  if (missing.length > 0) {
    return new SinkEmailAdapter(
      `EMAIL_PROVIDER is "smtp" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. `
        + 'Messages are recorded locally and NOT delivered.',
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
