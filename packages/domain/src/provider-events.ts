import { randomBytes } from 'node:crypto';
import type { Sql } from '@propertyos/db';

/**
 * A payment provider's notifications, recorded once.
 *
 * Shared by payments and by mandates because the three rules are the same for
 * both, and writing them twice is how two copies of a dedupe end up
 * disagreeing about what "already seen" means.
 *
 *   * an event that could not be verified is still recorded, because somebody
 *     posting rubbish at the notification endpoint is worth being able to see
 *     afterwards and the row is the only place it could show;
 *   * deduplication is the unique index on `(provider, provider_event_id)`
 *     doing the work rather than a read-then-write — providers retry, two
 *     retries can arrive at once, and a check followed by an insert lets both
 *     through;
 *   * what was done about it goes on the row, so "we received this and did
 *     nothing" is distinguishable from "we never received it".
 */

/** Records an event that cannot be trusted, under an id of our own. */
export async function recordUnverifiedEvent(
  tx: Sql,
  params: { provider: string; payload: unknown; reason?: string },
): Promise<void> {
  await tx`
    insert into webhook_events (
      provider, provider_event_id, event_type, signature_verified, payload,
      processed_at, processing_result
    ) values (
      ${params.provider}, ${`unverified-${randomBytes(8).toString('hex')}`},
      'unverified', false, ${JSON.stringify(params.payload)}::jsonb,
      now(), ${params.reason ?? 'refused: signature could not be verified'}
    )
  `;
}

/**
 * Records a verified event, or says it is a replay.
 *
 * Returns null when this provider has sent this event id before, which is the
 * normal case rather than an error: a provider that does not hear a prompt
 * 200 will try again, and it must be safe for it to.
 */
export async function recordVerifiedEvent(
  tx: Sql,
  params: {
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: unknown;
    organisationId?: string | null;
  },
): Promise<{ eventId: string } | null> {
  const [row] = await tx<{ id: string }[]>`
    insert into webhook_events (
      provider, provider_event_id, event_type, signature_verified, payload, organisation_id
    ) values (
      ${params.provider}, ${params.providerEventId}, ${params.eventType}, true,
      ${JSON.stringify(params.payload)}::jsonb,
      ${params.organisationId ?? null}
    )
    on conflict (provider, provider_event_id) do nothing
    returning id::text
  `;
  return row ? { eventId: row.id } : null;
}

/** What was done about it. */
export async function markEventProcessed(
  tx: Sql,
  params: { eventId: string; result: string },
): Promise<void> {
  await tx`
    update webhook_events
       set processed_at = now(), processing_result = ${params.result}
     where id = ${params.eventId}::uuid
  `;
}
