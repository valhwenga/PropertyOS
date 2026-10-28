import { NextResponse } from 'next/server';
import { privilegedSql } from '@propertyos/db/client';
import { ingestMandateEvent, ingestProviderEvent } from '@propertyos/domain';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { log } from '@/lib/logger';

/**
 * Where a payment provider tells us what happened.
 *
 * The only path in this product that can mark one of Spike's invoices paid,
 * and the reason ADR 0004's rule is structurally true: the customer's browser
 * never comes through here, and the state that settles an invoice is not
 * reachable from anything the browser can touch.
 *
 * Four things it does, in this order, and the order is the point.
 *
 * It does not trust the body. The provider adapter verifies a signature and
 * returns null for anything it cannot vouch for; an unverified notification is
 * recorded and changes nothing.
 *
 * It runs on the privileged connection, because a provider is not a user and
 * has no session. There is nothing for Row Level Security to key on.
 *
 * It answers 200 to anything it has recorded, including rubbish. A non-2xx is
 * an instruction to a provider to try again, and a forged request should not
 * be able to make an endpoint retry-storm itself; what happened is on the
 * `webhook_events` row rather than in the status code.
 *
 * And it never says what it found. "No attempt with that reference" to an
 * unauthenticated caller is a way to probe which references exist.
 *
 * One endpoint for both kinds, because a provider posts everything it has to
 * say to one URL. The adapter decides what an event IS — a payment or a
 * mandate — and this routes on that rather than on the path, which a caller
 * controls.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: named } = await context.params;
  const provider = resolvePaymentProvider();

  if (provider.name !== named) {
    // A notification for a provider this deployment is not configured for.
    // Recorded nowhere, because we have nothing to verify it with.
    log('warn', 'payment notification for an unconfigured provider', { named });
    return new NextResponse('OK', { status: 200 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  let raw: Record<string, string> = {};
  let payload: unknown = null;

  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      payload = body;
      raw = Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, String(value ?? '')]),
      );
    } else {
      // Form-encoded, which is what the South African providers post.
      const form = await request.formData();
      raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
      payload = raw;
    }
  } catch {
    return new NextResponse('OK', { status: 200 });
  }

  const sourceIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const event = await provider.verify(raw, { sourceIp });

  const sql = privilegedSql();
  const outcome = await sql.begin(async (tx) => (
    event?.kind === 'mandate'
      ? ingestMandateEvent(tx as never, {
        provider: provider.name,
        signatureVerified: true,
        payload,
        event,
      })
      : ingestProviderEvent(tx as never, {
        provider: provider.name,
        signatureVerified: event !== null,
        payload,
        event: event?.kind === 'payment' ? event : null,
      })
  ));

  log('info', 'payment notification handled', {
    provider: provider.name,
    outcome: outcome.outcome,
    ...(outcome.outcome === 'recorded' ? { status: outcome.status } : {}),
  });

  return new NextResponse('OK', { status: 200 });
}
