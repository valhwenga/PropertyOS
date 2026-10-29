import { createHmac, timingSafeEqual } from 'node:crypto';

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

/* ------------------------------------------------------------------ webhooks */

/**
 * What a provider says happened to a message after it accepted it.
 *
 * Acceptance is not arrival: the mailbox may not exist, may be full, or the
 * recipient may mark the message as spam, and all of that comes back
 * afterwards. Everything below is about reading those reports without trusting
 * the body they arrive in.
 */
export interface EmailEvent {
  /** The provider's id for this delivery, which matches `provider_message_id`. */
  providerMessageId: string | null;
  kind: 'delivered' | 'bounced' | 'complained' | 'delayed' | 'other';
  /** For a bounce: whether the address is gone, or merely unavailable today. */
  bounceKind: 'hard' | 'soft' | 'complaint' | 'blocked' | null;
  /** The recipient, as the provider reports it. */
  address: string | null;
  /** The provider's own words, which is what an operator needs. */
  detail: string;
  /** The raw type string, recorded as-is for anything we do not model. */
  type: string;
}

/**
 * Verifies a Resend webhook, which is signed in the Svix scheme.
 *
 * The signed content is `<id>.<timestamp>.<raw body>`, HMAC-SHA256 under the
 * secret (which is base64 after its `whsec_` prefix), base64-encoded. The
 * header carries one or more space-separated `v1,<signature>` pairs, because a
 * secret being rotated means two valid signatures for a while — so any match
 * is a pass.
 *
 * Three refusals, all deliberate:
 *
 *   * **No secret configured is a refusal, not a pass.** An endpoint that
 *     accepts unsigned events is an endpoint anybody can use to mark a rent
 *     reminder undeliverable.
 *   * **A stale timestamp is a refusal**, because a captured request must not
 *     be replayable forever. Five minutes either way, which is the provider's
 *     own tolerance and allows for clock drift.
 *   * **The comparison is constant-time**, since a timing oracle on a
 *     signature check is a signature check.
 *
 * It takes the RAW body. Re-serialising parsed JSON changes bytes — key order,
 * whitespace, unicode escapes — and the signature is over the bytes.
 */
export function verifyResendWebhook(
  secret: string | undefined,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
  rawBody: string,
  now: Date = new Date(),
): { verified: true } | { verified: false; reason: string } {
  if (!secret) {
    return {
      verified: false,
      reason: 'RESEND_WEBHOOK_SECRET is not set, so nothing can be verified. The event is '
        + 'recorded and changes nothing.',
    };
  }
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { verified: false, reason: 'The request is missing its svix signature headers.' };
  }

  const seconds = Number(headers.timestamp);
  if (!Number.isFinite(seconds)) {
    return { verified: false, reason: 'The svix-timestamp header is not a timestamp.' };
  }
  const driftSeconds = Math.abs(now.getTime() / 1000 - seconds);
  if (driftSeconds > 300) {
    return {
      verified: false,
      reason: `The signature is ${Math.round(driftSeconds)}s out of date, so it is refused as a `
        + 'replay.',
    };
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest();

  // One or more `v1,<sig>` pairs: a secret mid-rotation signs with both.
  const offered = headers.signature.split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3));

  for (const candidate of offered) {
    const given = Buffer.from(candidate, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { verified: true };
    }
  }

  return { verified: false, reason: 'The signature does not match.' };
}

/**
 * Reads one Resend event, defensively.
 *
 * Every field is checked rather than assumed: this is a parser for somebody
 * else's JSON, and an event whose shape has moved should degrade to `other`
 * with the raw type recorded, not throw inside a webhook handler.
 */
export function readResendEvent(payload: unknown): EmailEvent {
  const body = (payload ?? {}) as {
    type?: unknown;
    data?: {
      email_id?: unknown; to?: unknown; subject?: unknown;
      bounce?: { type?: unknown; subType?: unknown; message?: unknown };
    };
  };
  const type = typeof body.type === 'string' ? body.type : '';
  const data = body.data ?? {};

  const providerMessageId = typeof data.email_id === 'string' ? data.email_id : null;
  const address = Array.isArray(data.to)
    ? (typeof data.to[0] === 'string' ? data.to[0] : null)
    : typeof data.to === 'string' ? data.to : null;

  const bounceType = typeof data.bounce?.type === 'string' ? data.bounce.type.toLowerCase() : '';
  const bounceSub = typeof data.bounce?.subType === 'string' ? data.bounce.subType : '';
  const bounceMessage = typeof data.bounce?.message === 'string' ? data.bounce.message : '';

  if (type === 'email.bounced') {
    // Resend reports the class; anything it does not classify is treated as
    // HARD, because the cost of guessing wrong the other way is reminding a
    // dead address every month forever.
    const kind: EmailEvent['bounceKind'] = bounceType === 'soft' || bounceType === 'transient'
      ? 'soft'
      : bounceType === 'blocked' || bounceSub === 'Suppressed' ? 'blocked' : 'hard';
    return {
      providerMessageId, kind: 'bounced', bounceKind: kind, address, type,
      detail: [bounceType, bounceSub, bounceMessage].filter(Boolean).join(' — ')
        || 'The provider reported a bounce with no reason.',
    };
  }

  if (type === 'email.complained') {
    return {
      providerMessageId, kind: 'complained', bounceKind: 'complaint', address, type,
      detail: bounceMessage || 'The recipient marked the message as spam.',
    };
  }

  if (type === 'email.delivered') {
    return {
      providerMessageId, kind: 'delivered', bounceKind: null, address, type,
      detail: 'The receiving server accepted it.',
    };
  }

  if (type === 'email.delivery_delayed') {
    return {
      providerMessageId, kind: 'delayed', bounceKind: null, address, type,
      detail: bounceMessage || 'The provider is still trying.',
    };
  }

  return {
    providerMessageId, kind: 'other', bounceKind: null, address, type,
    detail: type ? `Unhandled event type ${type}.` : 'An event with no type.',
  };
}
