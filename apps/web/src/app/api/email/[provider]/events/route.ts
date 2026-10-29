import { NextResponse } from 'next/server';
import { privilegedSql } from '@propertyos/db/client';
import { ingestEmailEvent } from '@propertyos/domain';
import { readResendEvent, verifyResendWebhook } from '@propertyos/integrations';
import { log } from '@/lib/logger';

/**
 * Where the mail provider says what became of a message.
 *
 * Until this existed, `sent` was the last thing the product ever learned.
 * Acceptance is not arrival, and everything that happens after it — the
 * mailbox that does not exist, the one that is full, the recipient who marks
 * the message as spam — arrives here or nowhere.
 *
 * The same shape as the payment notification endpoint, and for the same
 * reasons.
 *
 * It reads the RAW body before anything else, because the signature is over
 * the bytes. Re-serialising parsed JSON changes key order and whitespace and
 * breaks a signature that was perfectly good.
 *
 * It does not trust the body. An event it cannot vouch for is recorded with
 * `signature_verified = false` and changes nothing — which is the whole
 * protection, because otherwise anybody who could post here could mark a
 * landlord's own address undeliverable and silence their rent reminders.
 *
 * It runs on the privileged connection: a provider is not a user and has no
 * session, so there is nothing for Row Level Security to key on.
 *
 * It answers 200 to anything it has recorded, including rubbish. A non-2xx
 * tells a provider to retry, and a forged request must not be able to make
 * this endpoint retry-storm itself. What happened is on the `webhook_events`
 * row rather than in the status code.
 *
 * And it never says what it found. "No message with that id" told to an
 * unauthenticated caller is a way to enumerate which ids exist.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;

  // One provider implements this. The path is checked rather than trusted,
  // because the path is the one part of the request a caller chooses.
  if (provider !== 'resend') {
    log('warn', 'email event for an unsupported provider', { provider });
    return new NextResponse('OK', { status: 200 });
  }

  const raw = await request.text();
  if (raw.length > 64_000) {
    // A provider event is a few hundred bytes. Anything of this size is not
    // one, and parsing it would be the point of sending it.
    log('warn', 'oversized email event body refused', { bytes: raw.length });
    return new NextResponse('OK', { status: 200 });
  }

  const svixId = request.headers.get('svix-id');
  const check = verifyResendWebhook(
    process.env.RESEND_WEBHOOK_SECRET,
    {
      id: svixId,
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    raw,
  );

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    log('warn', 'email event body was not json');
    return new NextResponse('OK', { status: 200 });
  }

  const event = readResendEvent(payload);

  // Without a provider event id there is nothing to deduplicate on, and a
  // provider that retries would act twice. The hash of the body is a poor key
  // and better than none: the same event retried is the same bytes.
  const eventId = svixId ?? `unsigned-${await digest(raw)}`;

  const sql = privilegedSql();
  try {
    const outcome = await sql.begin(async (tx) => ingestEmailEvent(tx as never, {
      provider: 'resend',
      providerEventId: eventId,
      event,
      payload,
      signatureVerified: check.verified,
      verificationReason: check.verified ? null : check.reason,
    }));

    if (!check.verified) {
      // Warned about every time, because a webhook that cannot be verified is
      // a webhook that is doing nothing, and silence would look like health.
      log('warn', 'email event could not be verified', {
        reason: check.reason, type: event.type,
      });
    } else if (!outcome.duplicate) {
      log('info', 'email event recorded', {
        type: event.type, summary: outcome.summary, suppressed: outcome.suppressed,
      });
    }
  } catch (error) {
    // A 500 would make the provider retry, which is right when the failure is
    // ours and transient. The event id makes the retry safe.
    log('error', 'email event could not be recorded', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new NextResponse('error', { status: 500 });
  }

  return new NextResponse('OK', { status: 200 });
}

async function digest(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const hashed = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hashed)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
