import type { Sql } from './queue';

/**
 * Publishes outbox events as jobs.
 *
 * The outbox row was written in the SAME transaction as the business change, so
 * an event can never describe a transaction that rolled back, and can never be
 * lost because the process crashed before "sending" it.
 *
 * Delivery is at-least-once: `jobs.idempotency_key` is derived from the outbox
 * id, so publishing the same event twice produces one job, and the handlers are
 * themselves idempotent.
 */
export async function publishOutbox(sql: Sql, batchSize = 50): Promise<number> {
  const events = await sql<
    {
      id: string; organisation_id: string; event_type: string;
      resource_type: string; resource_id: string | null;
      payload: Record<string, unknown>; correlation_id: string | null;
    }[]
  >`
    select id, organisation_id, event_type, resource_type, resource_id, payload, correlation_id
    from outbox_events
    where published_at is null
    order by id
    for update skip locked
    limit ${batchSize}
  `;
  if (events.length === 0) return 0;

  await sql.begin(async (tx) => {
    for (const event of events) {
      await tx`
        insert into jobs (organisation_id, job_type, payload, idempotency_key, correlation_id)
        values (
          ${event.organisation_id},
          ${`event:${event.event_type}`},
          ${tx.json({
            outboxId: event.id,
            eventType: event.event_type,
            resourceType: event.resource_type,
            resourceId: event.resource_id,
            ...event.payload,
          } as never)},
          ${`outbox-${event.id}`},
          ${event.correlation_id}
        )
        on conflict (job_type, idempotency_key) where idempotency_key is not null
        do nothing
      `;
      await tx`update outbox_events set published_at = now() where id = ${event.id}`;
    }
  });
  return events.length;
}
