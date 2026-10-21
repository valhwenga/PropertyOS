/**
 * Every event the domain can emit has somewhere to go.
 *
 * The defect this exists to prevent: the worker looks up `event:<type>` in its
 * registry, a type nobody registered has no handler, and `failJob` retries it
 * with backoff and then marks it **dead**. So emitting an event the worker had
 * never heard of turned a successful business action into a permanently failed
 * job and a red "Failed jobs — needs an operator to inspect" figure on the
 * platform console. Five types were in that state, three of them added only
 * hours before this test was written, and nothing anywhere said so.
 *
 * Two halves make it hard to repeat: `emitEvent` takes the closed union
 * `OutboxEventType`, so an undeclared event is a compile error, and this
 * asserts the registry covers the union in both directions.
 */
import { describe, it, expect } from 'vitest';
import { OUTBOX_EVENT_TYPES } from '@propertyos/domain';
import { HANDLERS } from '../../apps/worker/src/handlers';

describe('the worker handler registry', () => {
  it('has a handler for every event type the domain can emit', () => {
    const missing = OUTBOX_EVENT_TYPES.filter((type) => !(`event:${type}` in HANDLERS));
    expect(
      missing,
      'These events would be retried and then marked dead, and would show on the '
        + 'platform console as failed jobs needing an operator.',
    ).toEqual([]);
  });

  it('registers nothing the domain cannot emit', () => {
    // A handler for an event that no longer exists is dead weight, and reading
    // it later as "this is handled" is worse than dead weight.
    const declared = new Set<string>(OUTBOX_EVENT_TYPES.map((t) => `event:${t}`));
    const orphans = Object.keys(HANDLERS).filter(
      (key) => key.startsWith('event:') && !declared.has(key),
    );
    expect(orphans).toEqual([]);
  });
});
