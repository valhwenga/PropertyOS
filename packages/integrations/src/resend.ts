/**
 * Resend, over HTTPS.
 *
 * The SMTP client beside this one is the better protocol and the worse fit for
 * where this product runs: outbound 587 and 465 are closed in the cloud
 * environment, and a mail path that cannot be exercised where the code is
 * written is a mail path nobody trusts. Resend takes a JSON POST on 443, which
 * goes through the same egress as everything else.
 *
 * Dependency-free on purpose, like the SMTP client: one endpoint, one
 * recipient, no SDK to track.
 *
 * Two things here are not guesses about politeness, they are correctness.
 *
 * **The idempotency key.** The worker retries an undelivered notice up to four
 * times, and without a key a provider that accepted a message and then dropped
 * the connection would be asked to send it again. Resend holds a key for 24
 * hours and returns the original response rather than sending twice, so the
 * key is the notification's own id — stable across retries, unique per
 * message.
 *
 * **Rate limiting is not refusal.** The default allowance is a couple of
 * requests a second and a delivery pass can hold fifty messages. A 429 means
 * "ask again shortly", which is a different fact from "this message is not
 * acceptable", and recording the first as the second would eventually mark
 * real mail as failed. So the result carries `retryAfterSeconds`, and the
 * caller leaves the notice queued rather than spending one of its attempts.
 */

export interface ResendConfig {
  apiKey: string;
  /** The sender, which must be on a domain verified with Resend. */
  from: string;
  /** Overridable so the tests can point at a local stand-in. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ResendMessage {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  /** Up to 256 characters. The same key with the same payload sends once. */
  idempotencyKey?: string;
}

export type ResendResult =
  /** The provider accepted responsibility, and gave an id to look it up by. */
  | { accepted: true; id: string }
  /** It said no, in its own words. */
  | { accepted: false; error: string; status: number; retryAfterSeconds?: number };

const DEFAULT_BASE_URL = 'https://api.resend.com';

/** What Resend returns when it is unhappy; every field optional on purpose,
 *  because an error body is the last thing to trust the shape of. */
interface ResendError {
  message?: unknown;
  name?: unknown;
  statusCode?: unknown;
  error?: unknown;
}

function describe(status: number, body: string): string {
  let parsed: ResendError | null = null;
  try {
    parsed = JSON.parse(body) as ResendError;
  } catch {
    parsed = null;
  }
  const message = typeof parsed?.message === 'string' ? parsed.message
    : typeof parsed?.error === 'string' ? parsed.error
      : body.trim().slice(0, 300);
  const name = typeof parsed?.name === 'string' ? ` (${parsed.name})` : '';
  return message
    ? `Resend answered ${status}${name}: ${message}`
    : `Resend answered ${status}${name} with no explanation.`;
}

export async function sendViaResend(
  config: ResendConfig,
  message: ResendMessage,
): Promise<ResendResult> {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  };
  // Trimmed rather than rejected: a key longer than the provider accepts would
  // fail the whole send, and the first 256 characters of a uuid-shaped key are
  // still unique.
  if (message.idempotencyKey) {
    headers['idempotency-key'] = message.idempotencyKey.slice(0, 256);
  }

  let response: Response;
  try {
    response = await fetch(`${base}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.body,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
    });
  } catch (error) {
    // A network failure, a DNS refusal, or the timeout. None of them is a
    // refusal of the message, and all of them are worth trying again — but the
    // caller cannot tell from here whether the provider received it, which is
    // exactly what the idempotency key is for.
    const detail = error instanceof Error ? error.message : 'unknown transport error';
    return {
      accepted: false,
      error: `Resend could not be reached: ${detail}`,
      status: 0,
      retryAfterSeconds: 60,
    };
  }

  const body = await response.text();

  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after'));
    return {
      accepted: false,
      error: describe(429, body),
      status: 429,
      // A sensible floor: a provider that answers 429 without saying when is
      // still asking to be left alone for a moment.
      retryAfterSeconds: Number.isFinite(header) && header > 0 ? header : 10,
    };
  }

  // 5xx is the provider's own trouble rather than this message's.
  if (response.status >= 500) {
    return {
      accepted: false, error: describe(response.status, body), status: response.status,
      retryAfterSeconds: 60,
    };
  }

  if (!response.ok) {
    return { accepted: false, error: describe(response.status, body), status: response.status };
  }

  // A 2xx with no id is not a success this product can record. `sent` means
  // "the provider took responsibility AND we can find the message again" —
  // without an id the second half is false, and reporting it as sent would put
  // an untraceable claim of delivery in the audit trail. Retrying is safe: the
  // idempotency key means the provider will not send a second copy.
  let id: unknown;
  try {
    const parsed = JSON.parse(body) as { id?: unknown; data?: { id?: unknown } };
    id = parsed.id ?? parsed.data?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || id.length === 0) {
    return {
      accepted: false,
      status: response.status,
      error: `Resend answered ${response.status} without a message id, so there is nothing `
        + 'to trace the message by. It may have been accepted; the idempotency key means '
        + 'asking again cannot send a second copy.',
      retryAfterSeconds: 60,
    };
  }

  return { accepted: true, id };
}

/**
 * Checks the key without putting anything in anybody's inbox.
 *
 * The domains endpoint is a read. It answers whether the key works at all and,
 * usefully, which domains are verified — which is the thing that actually
 * stops a first send working, long after the key is right.
 */
export async function verifyResendKey(
  config: ResendConfig,
): Promise<{ ok: true; domains: string[] } | { ok: false; error: string }> {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/domains`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
    });
    const body = await response.text();
    if (!response.ok) return { ok: false, error: describe(response.status, body) };

    // Read defensively: this is a diagnostic, and a changed response shape must
    // not make a working key look broken.
    const domains: string[] = [];
    try {
      const parsed = JSON.parse(body) as {
        data?: Array<{ name?: unknown; status?: unknown }>;
      };
      for (const entry of parsed.data ?? []) {
        if (typeof entry.name === 'string') {
          domains.push(
            typeof entry.status === 'string' ? `${entry.name} (${entry.status})` : entry.name,
          );
        }
      }
    } catch { /* the key works, which is what was asked */ }
    return { ok: true, domains };
  } catch (error) {
    return {
      ok: false,
      error: `Resend could not be reached: ${
        error instanceof Error ? error.message : 'unknown transport error'}`,
    };
  }
}
