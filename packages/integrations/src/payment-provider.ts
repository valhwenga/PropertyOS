import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Taking money for Spike's own invoices.
 *
 * Two implementations behind one interface, and the shape of the interface is
 * the whole design decision: a provider can tell us to send somebody somewhere
 * (`checkout`), and it can tell us what happened, out of band, in a way we can
 * check (`verify`). Nothing else. In particular there is no method that asks a
 * provider "did this succeed?" at the moment the customer's browser comes
 * back, because ADR 0004 settled that a redirect proves nothing.
 *
 *   * `SandboxPaymentProvider` is local and complete: it signs its own
 *     notifications with HMAC-SHA256 and verifies them the same way, so the
 *     entire path — attempt, redirect, notification, verification, dedupe,
 *     invoice settled — runs end to end in the preview and in the test suite
 *     with no account anywhere.
 *   * `UnavailablePaymentProvider` is what you get when a real provider is
 *     named and not implemented. It throws with the reason rather than
 *     no-opping, in the same way `resolveStorageAdapter` refuses to pretend a
 *     file was saved.
 *
 * Payfast is the chosen provider and is deliberately NOT implemented here.
 * Writing its signature rule, its ITN field names and its validation callback
 * from memory is exactly the kind of guess that fails silently — a signature
 * that is subtly wrong rejects every real payment, and one that is wrongly
 * permissive accepts forged ones. It needs the official specification, which
 * this environment cannot currently reach.
 */

export interface PaymentRequest {
  /** Ours. The provider echoes it back, and it is how an event finds its attempt. */
  reference: string;
  amountMinor: number;
  currencyCode: string;
  description: string;
  payerName?: string;
  payerEmail?: string;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
}

/**
 * Where to send the payer.
 *
 * `fields` exists because the common South African shape is an auto-submitting
 * form POST rather than a link: the page renders hidden inputs and submits
 * them. A provider that wants a plain redirect returns no fields.
 */
export interface PaymentCheckout {
  url: string;
  method: 'GET' | 'POST';
  fields: Record<string, string>;
}

export type PaymentEventStatus = 'pending' | 'confirmed' | 'failed' | 'cancelled';

/** A provider's word about an attempt, once it has been checked. */
export interface ProviderPaymentEvent {
  /** The provider's own id for this event, for deduplicating replays. */
  providerEventId: string;
  eventType: string;
  reference: string;
  providerReference: string | null;
  status: PaymentEventStatus;
  amountMinor: number | null;
  feeMinor: number | null;
  netMinor: number | null;
}

export interface PaymentProvider {
  readonly name: string;
  /** False when the provider is named but cannot be used. */
  readonly available: boolean;
  /** Why not, for a screen to show rather than a shrug. */
  readonly unavailableReason?: string;
  checkout(request: PaymentRequest): Promise<PaymentCheckout>;
  /**
   * Checks an inbound notification and says what it means.
   *
   * Returns null when it cannot be trusted — a wrong signature, a missing
   * field, anything unexpected. The caller records the attempt as unverified
   * and changes nothing, because an event that cannot be checked is not
   * evidence of money.
   */
  verify(
    raw: Record<string, string>,
    context: { sourceIp?: string | undefined },
  ): Promise<ProviderPaymentEvent | null>;
}

export class UnavailablePaymentProvider implements PaymentProvider {
  readonly available = false;
  constructor(readonly name: string, readonly unavailableReason: string) {}

  async checkout(): Promise<PaymentCheckout> {
    throw new Error(`No payment provider is available: ${this.unavailableReason}`);
  }

  async verify(): Promise<ProviderPaymentEvent | null> {
    return null;
  }
}

/** The fields the sandbox signs, in a fixed order. Order is part of a signature. */
const SANDBOX_SIGNED = [
  'reference', 'provider_reference', 'status', 'amount_minor', 'fee_minor', 'net_minor', 'event_id',
] as const;

export function signSandboxNotification(
  fields: Record<string, string>,
  secret: string,
): string {
  const canonical = SANDBOX_SIGNED.map((key) => `${key}=${fields[key] ?? ''}`).join('&');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * A payment provider that exists entirely inside this product.
 *
 * Not a mock: it implements the interface honestly, including a real signature
 * over a canonical string, so the verification path, the dedupe and the
 * refusal of an unsigned event are all exercised by the same code that a real
 * provider will go through. What it cannot do is move money, and the screens
 * say which provider took a payment.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly available = true;
  constructor(private readonly secret: string, private readonly baseUrl: string) {}

  async checkout(request: PaymentRequest): Promise<PaymentCheckout> {
    // A page inside this application standing in for the provider's hosted
    // page. It is reached by GET because there is nothing to hide from the
    // payer: this is development, and the page says so loudly.
    const url = new URL(`/pay/sandbox/${encodeURIComponent(request.reference)}`, this.baseUrl);
    url.searchParams.set('amount', String(request.amountMinor));
    url.searchParams.set('currency', request.currencyCode);
    url.searchParams.set('description', request.description);
    return { url: url.toString(), method: 'GET', fields: {} };
  }

  async verify(raw: Record<string, string>): Promise<ProviderPaymentEvent | null> {
    const given = raw.signature ?? '';
    const expected = signSandboxNotification(raw, this.secret);
    if (given.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;

    const status = raw.status;
    if (status !== 'confirmed' && status !== 'failed' && status !== 'cancelled'
      && status !== 'pending') {
      return null;
    }
    if (!raw.reference || !raw.event_id) return null;

    const number = (value: string | undefined) =>
      value === undefined || value === '' ? null : Number(value);

    return {
      providerEventId: raw.event_id,
      eventType: `payment.${status}`,
      reference: raw.reference,
      providerReference: raw.provider_reference ?? null,
      status,
      amountMinor: number(raw.amount_minor),
      feeMinor: number(raw.fee_minor),
      netMinor: number(raw.net_minor),
    };
  }
}

/**
 * Resolves the provider from the environment.
 *
 * `none` is the default and is a real answer: Spike's invoices are settled by
 * an operator reading the bank statement, which is how this product has always
 * worked and is not broken.
 *
 * Naming a provider that is not implemented produces an adapter that refuses
 * with the reason, rather than one that quietly does nothing. The worker's
 * preflight turns that into a refusal to start, so a deployment cannot be
 * configured to take payments it cannot take.
 */
export function resolvePaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProvider {
  const choice = (env.SUBSCRIPTION_PAYMENT_PROVIDER ?? 'none').toLowerCase();

  if (choice === 'none') {
    return new UnavailablePaymentProvider(
      'none',
      'SUBSCRIPTION_PAYMENT_PROVIDER is not set. Invoices are settled by hand from '
      + "Spike's bank statement.",
    );
  }

  if (choice === 'sandbox') {
    const secret = env.PAYMENT_SANDBOX_SECRET ?? '';
    if (secret.length < 32) {
      return new UnavailablePaymentProvider(
        'sandbox',
        'PAYMENT_SANDBOX_SECRET must be at least 32 characters for the sandbox provider '
        + 'to sign its own notifications.',
      );
    }
    return new SandboxPaymentProvider(secret, env.APP_BASE_URL ?? 'http://localhost:3000');
  }

  if (choice === 'payfast') {
    return new UnavailablePaymentProvider(
      'payfast',
      'The Payfast adapter is not implemented. Its signature rule, its ITN field names '
      + 'and its server-side validation callback have to come from the official '
      + 'specification rather than from memory: a signature that is subtly wrong rejects '
      + 'every real payment, and a permissive one accepts forged ones.',
    );
  }

  return new UnavailablePaymentProvider(
    choice,
    `SUBSCRIPTION_PAYMENT_PROVIDER is "${choice}", which this product has no adapter for.`,
  );
}
