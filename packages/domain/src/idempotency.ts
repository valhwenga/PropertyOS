import { createHash } from 'node:crypto';
import type { Sql } from '@propertyos/db';
import { DomainError } from './errors';

/**
 * Doing it once, however many times it is asked for.
 *
 * The table has existed since 0006 and only billing runs used it, so every
 * other command was one double-click away from a second receipt. The ordinary
 * causes are mundane and constant: an impatient second click, a form resubmitted
 * after a connection drop, a mobile browser replaying a request it thinks
 * failed. None of them is a user error, and none of them should cost a resident
 * a duplicated charge or a landlord a receipt they have to reverse.
 *
 * The key binds four things, which is what makes it safe:
 *
 *   organisation — one customer's key can never match another's;
 *   actor        — two colleagues clicking at once are two different intents,
 *                  which 0052 moved into the unique index rather than leaving
 *                  to a comparison after the fact;
 *   command      — the same key from a different screen is a different request;
 *   payload hash — the same key with CHANGED CONTENT is a mistake, not a
 *                  replay, and is refused rather than silently answered with
 *                  the earlier result.
 *
 * The guarantee is the unique index, not this code. Two concurrent attempts
 * both reach the insert; one wins, and the other BLOCKS there until the first
 * transaction ends, because that is what a unique index does to a conflicting
 * insert. It then either sees the committed row and replays it, or — if the
 * first attempt failed and rolled the row away with it — proceeds as the only
 * attempt. There is no window in which both run.
 *
 * A failed command leaves nothing behind. The key row is written in the same
 * transaction as the work, so a rollback takes it too, and the caller may
 * retry with the same key. That is deliberate: a key that outlived a failure
 * would turn one network error into a command nobody can ever run.
 */

export interface IdempotencyContext {
  organisationId: string;
  actorUserId: string;
  /** The command's stable name, e.g. 'receipt.record'. */
  command: string;
  /** The caller's key for this attempt. One form instance, one key. */
  key: string;
  /** Everything that makes this request what it is. Hashed, never stored. */
  payload: unknown;
}

export interface IdempotentOutcome<T> {
  result: T;
  /** True when this call returned the stored result of an earlier attempt. */
  replayed: boolean;
}

/**
 * A stable JSON encoding: object keys sorted, bigints as decimal strings.
 *
 * Two requests that differ only in the order a form serialised its fields are
 * the same request, and must hash the same. A money amount is a bigint, which
 * `JSON.stringify` refuses outright — a thrown TypeError in the middle of a
 * payment would be a poor way to learn that.
 */
export function canonicalJson(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(encode);
    if (v instanceof Date) return v.toISOString();
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, item]) => [k, encode(item)]));
  };
  return JSON.stringify(encode(value));
}

export function payloadHash(payload: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest();
}

/**
 * Runs `fn` once for a given key, and returns the stored result thereafter.
 *
 * The result is stored as JSON, so an idempotent command must return a
 * JSON-safe shape — identifiers, numbers, strings. A bigint survives as a
 * decimal string, which is the same way money crosses every other boundary in
 * this product, and the caller reads it back as one.
 */
export async function withIdempotency<T>(
  tx: Sql,
  context: IdempotencyContext,
  fn: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const key = context.key.trim();
  if (key.length < 8 || key.length > 200) {
    throw new DomainError('validation_failed', 'An idempotency key must be between 8 and 200 characters.');
  }
  const hash = payloadHash(context.payload);

  const claimed = await tx<{ id: string }[]>`
    insert into idempotency_keys (organisation_id, actor_user_id, command, key, payload_sha256)
    values (${context.organisationId}::uuid, ${context.actorUserId}::uuid,
            ${context.command}, ${key}, ${hash})
    on conflict (organisation_id, actor_user_id, command, key) do nothing
    returning id
  `;

  if (claimed.length === 0) {
    const [existing] = await tx<
      { actor_user_id: string | null; payload_sha256: Buffer; status: string; result: unknown }[]
    >`
      select actor_user_id, payload_sha256, status, result
        from idempotency_keys
       where organisation_id = ${context.organisationId}::uuid
         and actor_user_id = ${context.actorUserId}::uuid
         and command = ${context.command} and key = ${key}
    `;
    if (!existing) {
      // The row vanished between the conflict and this read, which means the
      // transaction that held it rolled back. Saying so is better than
      // pretending to replay something that never happened.
      throw new DomainError('conflict', 'That request could not be completed. Please try again.');
    }
    if (!Buffer.from(existing.payload_sha256).equals(hash)) {
      throw new DomainError(
        'conflict',
        'This request was already used for different details. Start again rather than reusing it, '
          + 'so the earlier request is not mistaken for this one.',
      );
    }
    if (existing.status !== 'succeeded') {
      throw new DomainError('conflict', 'That request is still being processed. Please wait and check before retrying.');
    }
    return { result: existing.result as T, replayed: true };
  }

  const result = await fn();

  await tx`
    update idempotency_keys
       set status = 'succeeded', completed_at = now(),
           result = ${tx.json(JSON.parse(canonicalJson(result ?? null)) as never)}
     where organisation_id = ${context.organisationId}::uuid
       and actor_user_id = ${context.actorUserId}::uuid
       and command = ${context.command} and key = ${key}
  `;

  return { result, replayed: false };
}
