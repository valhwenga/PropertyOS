/**
 * Email on a lease ending or extending must never be reported more generously
 * than it happened. These cases pin that: only a provider acknowledgement for
 * every single recipient reads as "sent".
 */
import { describe, expect, it } from 'vitest';
import type { EmailOutcome } from '@propertyos/integrations';
import { summariseEmail } from '../../apps/web/src/lib/lease-notices';

const sent = (id: string): EmailOutcome =>
  ({ status: 'sent', provider: 'smtp', providerMessageId: id });
const sink: EmailOutcome =
  { status: 'development_sink', provider: 'sink', reason: 'EMAIL_PROVIDER is not set to "smtp".' };
const failed: EmailOutcome =
  { status: 'failed', provider: 'smtp', error: '550 mailbox unavailable' };

describe('summariseEmail', () => {
  it('reports sent only when every message was acknowledged', () => {
    expect(summariseEmail([sent('a'), sent('b')]))
      .toEqual({ email: 'sent', emailDetail: null });
  });

  it('never calls the development sink a delivery', () => {
    expect(summariseEmail([sink])).toEqual({
      email: 'not delivered',
      emailDetail: 'EMAIL_PROVIDER is not set to "smtp".',
    });
  });

  it('reports a partial send as not delivered, with the reason', () => {
    // One tenant got it, the other did not. Calling that "sent" would hide a
    // person who was never told their lease is ending.
    expect(summariseEmail([sent('a'), failed])).toEqual({
      email: 'not delivered',
      emailDetail: '550 mailbox unavailable',
    });
  });

  it('says no address rather than claiming an attempt, when there was nobody to email', () => {
    expect(summariseEmail([])).toEqual({ email: 'no address', emailDetail: null });
  });
});
