/**
 * The Resend adapter, against a stand-in that answers like Resend.
 *
 * Why a local server rather than a stubbed `fetch`: the same reason the SMTP
 * tests run a real SMTP server. A stub proves the code calls the function it
 * was written to call; a server proves the request is well formed, the headers
 * are where they belong, and the answers are read the way they actually
 * arrive. Resend's own host is not reachable from this environment, so this is
 * as close to the real thing as can be had here — and the shapes it answers
 * with are the ones documented for `POST /emails`.
 *
 * What it pins, in order of what would cost somebody something:
 *
 *   1. `sent` requires a message id, not merely a 2xx — an untraceable claim
 *      of delivery in the audit trail is the one thing this product has
 *      refused since ADR 0004;
 *   2. a rate limit, a 5xx and an unreachable provider are *wait and retry*,
 *      which is a different record from a refusal and must not spend one of
 *      the four delivery attempts;
 *   3. the idempotency key goes out on every send, because four retries of a
 *      message the provider already accepted is four copies in an inbox;
 *   4. the API key never appears in anything that could be logged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  ResendEmailAdapter, resolveEmailAdapter, sendViaResend, verifyResendKey,
} from '@propertyos/integrations';

interface Received {
  path: string;
  method: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: Record<string, unknown>;
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

async function startResend(answers: Answer[]): Promise<{
  server: Server; baseUrl: string; received: Received[];
}> {
  const received: Received[] = [];
  let next = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        path: request.url ?? '',
        method: request.method ?? '',
        authorization: request.headers.authorization,
        idempotencyKey: request.headers['idempotency-key'] as string | undefined,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
      });
      const answer = answers[Math.min(next, answers.length - 1)]!;
      next += 1;
      response.writeHead(answer.status, {
        'content-type': 'application/json', ...(answer.headers ?? {}),
      });
      response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, received };
}

describe('Resend', () => {
  let open: Server | null = null;
  afterEach(async () => {
    if (open) await new Promise<void>((resolve) => open!.close(() => resolve()));
    open = null;
  });

  it('sends one message and reports the provider id', async () => {
    const { server, baseUrl, received } = await startResend([
      { status: 200, body: { id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' } },
    ]);
    open = server;

    const adapter = new ResendEmailAdapter({
      apiKey: 're_test_secret', from: 'Spike <no-reply@spike.invalid>', baseUrl,
    });
    const outcome = await adapter.send({
      to: 'thandiwe@demo.invalid',
      subject: 'Your statement for March',
      body: 'Amount due R1,150.00.',
      idempotencyKey: 'notice-7',
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status === 'sent') {
      expect(outcome.provider).toBe('resend');
      expect(outcome.providerMessageId).toBe('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    }

    const sent = received[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/emails');
    expect(sent.authorization).toBe('Bearer re_test_secret');
    expect(sent.idempotencyKey).toBe('notice-7');
    expect(sent.body.from).toBe('Spike <no-reply@spike.invalid>');
    expect(sent.body.to).toEqual(['thandiwe@demo.invalid']);
    expect(sent.body.subject).toBe('Your statement for March');
    expect(sent.body.text).toBe('Amount due R1,150.00.');
  });

  it('will not call a 2xx with no message id a send', async () => {
    // The shape this product cannot verify from here, and therefore the one it
    // refuses to assume: an accepted response it cannot read an id out of.
    // `sent` means "accepted AND traceable", and half of that is not enough to
    // write into an audit trail. Asking again is safe — the idempotency key
    // means the provider will not send a second copy.
    const { server, baseUrl } = await startResend([{ status: 200, body: { ok: true } }]);
    open = server;

    const outcome = await new ResendEmailAdapter({
      apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl,
    }).send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toMatch(/without a message id/);
      // And worth asking again, rather than a refusal.
      expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('reads the id when it arrives nested, which some responses do', async () => {
    const { server, baseUrl } = await startResend([{ status: 200, body: { data: { id: 'abc' } } }]);
    open = server;
    const outcome = await new ResendEmailAdapter({
      apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl,
    }).send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });
    expect(outcome.status).toBe('sent');
  });

  it('repeats the provider words when a message is refused, and does not ask again', async () => {
    const { server, baseUrl } = await startResend([{
      status: 403,
      body: {
        statusCode: 403, name: 'validation_error',
        message: 'The spike.invalid domain is not verified. Please verify your domain.',
      },
    }]);
    open = server;

    const outcome = await new ResendEmailAdapter({
      apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl,
    }).send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      // The operator needs the provider's own sentence: "domain is not
      // verified" is actionable and "delivery failed" is not.
      expect(outcome.error).toContain('not verified');
      expect(outcome.error).toContain('validation_error');
      // A refusal, so there is nothing to wait for.
      expect(outcome.retryAfterSeconds).toBeUndefined();
    }
  });

  it('treats a rate limit as wait-and-retry, with the provider own delay', async () => {
    const { server, baseUrl } = await startResend([{
      status: 429,
      body: { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' },
      headers: { 'retry-after': '7' },
    }]);
    open = server;

    const outcome = await new ResendEmailAdapter({
      apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl,
    }).send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.retryAfterSeconds).toBe(7);
  });

  it('treats the provider own trouble as wait-and-retry too', async () => {
    const { server, baseUrl } = await startResend([{ status: 503, body: 'upstream unavailable' }]);
    open = server;
    const result = await sendViaResend(
      { apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl },
      { to: 'a@demo.invalid', subject: 'S', body: 'B' },
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.status).toBe(503);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('reports an unreachable provider rather than hanging or lying', async () => {
    const result = await sendViaResend(
      // Port 1 is reserved and nothing listens there.
      { apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 },
      { to: 'a@demo.invalid', subject: 'S', body: 'B' },
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps the api key out of anything that could be logged', async () => {
    const { server, baseUrl } = await startResend([{
      status: 401, body: { name: 'validation_error', message: 'API key is invalid' },
    }]);
    open = server;

    const outcome = await new ResendEmailAdapter({
      apiKey: 're_live_a_real_looking_secret', from: 'no-reply@spike.invalid', baseUrl,
    }).send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).not.toContain('re_live_a_real_looking_secret');
    }
  });

  it('trims an over-long idempotency key rather than failing the send', async () => {
    const { server, baseUrl, received } = await startResend([{ status: 200, body: { id: 'x' } }]);
    open = server;
    await new ResendEmailAdapter({
      apiKey: 're_x', from: 'no-reply@spike.invalid', baseUrl,
    }).send({
      to: 'a@demo.invalid', subject: 'S', body: 'B', idempotencyKey: 'k'.repeat(400),
    });
    expect(received[0]!.idempotencyKey).toHaveLength(256);
  });

  it('checks the key without sending anything, and names the verified domains', async () => {
    const { server, baseUrl, received } = await startResend([{
      status: 200,
      body: { data: [{ name: 'spike.co.za', status: 'verified' }, { name: 'old.co.za', status: 'pending' }] },
    }]);
    open = server;

    const checked = await verifyResendKey({ apiKey: 're_x', from: 'f@spike.co.za', baseUrl });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.domains).toEqual(['spike.co.za (verified)', 'old.co.za (pending)']);
    }
    // A read, and no message.
    expect(received[0]!.method).toBe('GET');
    expect(received[0]!.path).toBe('/domains');
  });

  it('still uses the sink, never a silent success, when Resend is half-configured', () => {
    expect(resolveEmailAdapter({ EMAIL_PROVIDER: 'resend' } as NodeJS.ProcessEnv).name)
      .toBe('sink');
    expect(resolveEmailAdapter(
      { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' } as NodeJS.ProcessEnv,
    ).name).toBe('sink');
    expect(resolveEmailAdapter({
      EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.co',
    } as NodeJS.ProcessEnv).name).toBe('resend');

    // And the reason says what to set, because the person reading it on the
    // console is usually the person who has to fix it.
    const adapter = resolveEmailAdapter({ EMAIL_PROVIDER: 'resend' } as NodeJS.ProcessEnv);
    expect((adapter as { reason: string }).reason).toMatch(/RESEND_API_KEY and EMAIL_FROM/);
  });
});
