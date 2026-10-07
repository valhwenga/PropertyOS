/**
 * The two rules behind notifying a lease's residents.
 *
 * First, delivery is never reported more generously than it happened: only a
 * provider acknowledgement for every single recipient reads as "sent".
 *
 * Second, a resident's communication preference is respected by every notice
 * except a lease ending, which overrides it and says so.
 */
import { describe, expect, it } from 'vitest';
import type { EmailOutcome } from '@propertyos/integrations';
import { chooseEmailRecipients, summariseEmail } from '../../apps/web/src/lib/lease-notices';

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

/**
 * A resident's communication preference is respected by every notice but one.
 *
 * A lease ending changes where someone lives and what they owe, so it is sent by
 * email whatever they chose. Nothing else may do that, which is what the first
 * case here pins.
 */
describe('chooseEmailRecipients', () => {
  const wants = { authUserId: 'a', email: 'wants@demo.invalid', wantsEmail: true };
  const optedOut = { authUserId: 'b', email: 'opted-out@demo.invalid', wantsEmail: false };
  const noAddress = { authUserId: 'c', email: null, wantsEmail: true };

  it('leaves out a resident who asked not to be emailed', () => {
    expect(chooseEmailRecipients([wants, optedOut], false)).toEqual({
      addresses: ['wants@demo.invalid'],
      overrodePreference: 0,
      optedOut: 1,
    });
  });

  it('emails them anyway when the notice overrides, and counts whose choice that was', () => {
    expect(chooseEmailRecipients([wants, optedOut], true)).toEqual({
      addresses: ['wants@demo.invalid', 'opted-out@demo.invalid'],
      overrodePreference: 1,
      optedOut: 0,
    });
  });

  it('does not count someone who wanted email as an override', () => {
    expect(chooseEmailRecipients([wants], true)).toEqual({
      addresses: ['wants@demo.invalid'],
      overrodePreference: 0,
      optedOut: 0,
    });
  });

  it('cannot email a resident with no address, override or not', () => {
    // And no address is NOT an opt-out: the operator would go looking for a
    // preference that was never set.
    expect(chooseEmailRecipients([noAddress], true)).toEqual({
      addresses: [], overrodePreference: 0, optedOut: 0,
    });
    expect(chooseEmailRecipients([noAddress], false)).toEqual({
      addresses: [], overrodePreference: 0, optedOut: 0,
    });
  });

  it('counts people rather than addresses when two share one', () => {
    // Joint tenants on one mailbox. Two preferences were overridden, even
    // though one message goes out.
    const joint = { authUserId: 'd', email: 'opted-out@demo.invalid', wantsEmail: false };
    expect(chooseEmailRecipients([optedOut, joint], true)).toEqual({
      addresses: ['opted-out@demo.invalid'],
      overrodePreference: 2,
      optedOut: 0,
    });
  });
});
