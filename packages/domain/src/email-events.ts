import type { Sql } from '@propertyos/db';
import { invalid } from './errors';
import { recordAudit } from './audit';
import { requirePlatformPermission } from './platform';

/**
 * What became of a message after the provider accepted it.
 *
 * Until this existed, `sent` was the last thing the product ever learned about
 * a message. Acceptance is not arrival: the mailbox may not exist, may be
 * full, or the recipient may mark it as spam, and all of that arrives
 * afterwards by webhook. So a resident who moved out two years ago was still
 * sent a reminder every month, it was still recorded as sent, and the one
 * person who could fix it — the landlord, who has their phone number — was
 * never told.
 *
 * In the aggregate it is worse than a missed message: mail to dead addresses
 * is how a sending domain's reputation is destroyed, and the reputation is
 * shared by every customer on it. One stale tenancy list degrades delivery for
 * everybody.
 *
 * Two rules worth stating plainly.
 *
 * **A bounce does not rewrite the send.** `status` stays `sent`, because the
 * message was accepted and that is a true record; `bounced_at` and the
 * provider's reason are added beside it. "Accepted and then bounced" says more
 * than "failed".
 *
 * **Suppression is by address, globally.** A reputation is a property of the
 * address and the sending domain, not of whichever customer's resident it
 * happens to be. Which is exactly why no customer may read the list: an
 * address can belong to residents of two landlords, and one landlord does not
 * get to learn that a person complained about another's mail. What a customer
 * may see is the generalised answer, through
 * `app.resident_addresses_in_trouble`, and nothing else.
 */

export interface EmailEventRecord {
  providerMessageId: string | null;
  kind: 'delivered' | 'bounced' | 'complained' | 'delayed' | 'other';
  bounceKind: 'hard' | 'soft' | 'complaint' | 'blocked' | null;
  address: string | null;
  detail: string;
  type: string;
}

export interface EmailEventOutcome {
  /** Already seen. The provider retries, and retries must change nothing. */
  duplicate: boolean;
  /** Recorded but acted on by nothing, because it could not be vouched for. */
  unverified: boolean;
  /** The notice this was about, where one could be matched. */
  notificationId: string | null;
  suppressed: boolean;
  summary: string;
}

/**
 * Records one provider event and acts on it.
 *
 * Runs on the privileged connection: a mail provider is not a user and has no
 * session, so there is nothing for Row Level Security to key on. The dedupe is
 * `webhook_events (provider, provider_event_id)`, which has been in the schema
 * since 0004 and is the same mechanism the payment provider uses.
 *
 * An unverified event is recorded and changes nothing. That is the whole
 * protection here: without it, anybody who could post to the endpoint could
 * mark a landlord's address undeliverable and silence their own rent
 * reminders.
 */
export async function ingestEmailEvent(
  tx: Sql,
  params: {
    provider: string;
    providerEventId: string;
    event: EmailEventRecord;
    payload: unknown;
    signatureVerified: boolean;
    /** Why it could not be verified, recorded on the row. */
    verificationReason?: string | null;
  },
): Promise<EmailEventOutcome> {
  const { event } = params;

  const [recorded] = await tx<{ id: string }[]>`
    insert into webhook_events (
      provider, provider_event_id, event_type, signature_verified, payload
    ) values (
      ${params.provider}, ${params.providerEventId}, ${event.type || 'unknown'},
      ${params.signatureVerified}, ${tx.json(params.payload as never)}
    )
    on conflict (provider, provider_event_id) do nothing
    returning id::text
  `;
  if (!recorded) {
    return {
      duplicate: true, unverified: false, notificationId: null, suppressed: false,
      summary: 'already recorded',
    };
  }

  if (!params.signatureVerified) {
    await tx`
      update webhook_events
         set processed_at = now(),
             processing_result = ${`not verified: ${params.verificationReason ?? 'unknown'}`}
       where id = ${recorded.id}::uuid
    `;
    return {
      duplicate: false, unverified: true, notificationId: null, suppressed: false,
      summary: 'recorded unverified; nothing was changed',
    };
  }

  // Matched on the provider's own id for the message, which is what the
  // delivery pass stored when the provider accepted it.
  const [notice] = event.providerMessageId
    ? await tx<{ id: string; organisation_id: string; recipient_email: string | null }[]>`
        select id::text, organisation_id::text, recipient_email::text
          from notifications
         where provider_message_id = ${event.providerMessageId}
         limit 1
      `
    : [];

  const address = notice?.recipient_email ?? event.address;
  let suppressed = false;
  let summary: string;

  switch (event.kind) {
    case 'delivered': {
      if (notice) {
        await tx`
          update notifications set delivered_at = now() where id = ${notice.id}::uuid
        `;
      }
      summary = 'delivered';
      break;
    }

    case 'bounced':
    case 'complained': {
      const complaint = event.kind === 'complained';
      if (notice) {
        await tx`
          update notifications
             set bounced_at = ${complaint ? null : tx`now()`},
                 complained_at = ${complaint ? tx`now()` : null},
                 bounce_kind = ${event.bounceKind},
                 bounce_detail = ${event.detail}
           where id = ${notice.id}::uuid
        `;
      }

      // A soft bounce is today's trouble: a full mailbox, a greylisting, a
      // server having a bad afternoon. Suppressing on one would stop a
      // landlord's mail over a weekend. Only the permanent kinds stop us.
      const permanent = event.bounceKind === 'hard' || event.bounceKind === 'complaint'
        || event.bounceKind === 'blocked';

      if (permanent && address) {
        await tx`
          insert into email_suppressions (
            address, kind, reason, notification_id, organisation_id
          ) values (
            ${address},
            ${complaint ? 'complaint' : event.bounceKind === 'blocked' ? 'blocked' : 'hard_bounce'},
            ${event.detail},
            ${notice?.id ?? null}::uuid,
            ${notice?.organisation_id ?? null}::uuid
          )
          on conflict (address) where lifted_at is null do update
            set last_event_at = now(),
                events = email_suppressions.events + 1,
                reason = excluded.reason
        `;
        suppressed = true;
      }
      summary = complaint
        ? 'complaint recorded'
        : `${event.bounceKind} bounce recorded${suppressed ? ' and the address suppressed' : ''}`;
      break;
    }

    case 'delayed': {
      if (notice) {
        await tx`
          update notifications set bounce_detail = ${event.detail} where id = ${notice.id}::uuid
        `;
      }
      summary = 'delayed';
      break;
    }

    default:
      summary = `recorded, no action for ${event.type || 'an event with no type'}`;
  }

  await tx`
    update webhook_events
       set processed_at = now(), processing_result = ${summary},
           organisation_id = ${notice?.organisation_id ?? null}::uuid
     where id = ${recorded.id}::uuid
  `;

  return {
    duplicate: false,
    unverified: false,
    notificationId: notice?.id ?? null,
    suppressed,
    summary,
  };
}

/**
 * Queued messages addressed to somewhere nothing can be delivered.
 *
 * Belt and braces, and the braces matter: `noticesAwaitingDelivery` excludes
 * suppressed addresses so nothing is sent, but a notice that is merely
 * excluded sits `queued` forever, counts as a backlog, and tells nobody why.
 * This marks them `suppressed` with the reason, which is a state the schema
 * has allowed since 0006 and nothing had ever written.
 *
 * It does not touch the notices themselves otherwise, and it never deletes
 * one: what the product tried to say is a record, whether or not it could be
 * said.
 */
export async function suppressUndeliverableNotices(
  tx: Sql,
  limit = 200,
): Promise<{ suppressed: number }> {
  const rows = await tx<{ id: string }[]>`
    update notifications n
       set status = 'suppressed',
           last_error = 'Not sent: ' || s.kind || ' — ' || s.reason
      from email_suppressions s
     where n.recipient_email = s.address
       and s.lifted_at is null
       and n.channel = 'email'
       and n.status = 'queued'
       and n.id in (
         select id from notifications
          where channel = 'email' and status = 'queued'
          order by created_at
          limit ${limit}
       )
    returning n.id::text
  `;
  return { suppressed: rows.length };
}

export interface Suppression {
  id: string;
  address: string;
  kind: 'hard_bounce' | 'complaint' | 'blocked' | 'manual';
  reason: string;
  firstSuppressedAt: string;
  lastEventAt: string;
  events: number;
  organisationName: string | null;
  liftedAt: string | null;
  liftedByName: string | null;
  liftedReason: string | null;
}

/** The live suppressions, newest first, for the operator answering the ticket. */
export async function listSuppressions(
  tx: Sql,
  authUserId: string,
  options: { includeLifted?: boolean; limit?: number } = {},
): Promise<Suppression[]> {
  await requirePlatformPermission(tx, authUserId, 'platform.operations.manage');
  const rows = await tx<{
    id: string; address: string; kind: Suppression['kind']; reason: string;
    first_suppressed_at: string; last_event_at: string; events: number;
    organisation_name: string | null; lifted_at: string | null;
    lifted_by_name: string | null; lifted_reason: string | null;
  }[]>`
    select s.id::text, s.address::text, s.kind, s.reason,
           s.first_suppressed_at::text, s.last_event_at::text, s.events,
           o.name as organisation_name, s.lifted_at::text,
           who.full_name as lifted_by_name, s.lifted_reason
      from email_suppressions s
      left join organisations o on o.id = s.organisation_id
      left join user_profiles who on who.auth_user_id = s.lifted_by
     where ${options.includeLifted ? tx`true` : tx`s.lifted_at is null`}
     order by s.last_event_at desc
     limit ${Math.min(options.limit ?? 100, 500)}
  `;
  return rows.map((r) => ({
    id: r.id,
    address: r.address,
    kind: r.kind,
    reason: r.reason,
    firstSuppressedAt: r.first_suppressed_at,
    lastEventAt: r.last_event_at,
    events: Number(r.events),
    organisationName: r.organisation_name,
    liftedAt: r.lifted_at,
    liftedByName: r.lifted_by_name,
    liftedReason: r.lifted_reason,
  }));
}

/**
 * Trying an address again, deliberately.
 *
 * Somebody will ask: the landlord says the mailbox is fixed, or the complaint
 * was a misclick. Lifting is recorded with a person and a reason rather than
 * deleting the row, because "we started sending there again because the
 * landlord said it was fine" is the answer a postmaster wants when the
 * reputation question comes round.
 *
 * It does not resend anything. The notices already marked `suppressed` stay
 * that way: re-sending a three-month-old rent reminder because an address came
 * back is not what anybody meant.
 */
export async function liftSuppression(
  tx: Sql,
  authUserId: string,
  params: { suppressionId: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.operations.manage');
  if (params.reason.trim().length < 5) {
    throw invalid('Say why this address is being tried again.');
  }

  const [lifted] = await tx<{ address: string; organisation_id: string | null }[]>`
    update email_suppressions
       set lifted_at = now(), lifted_by = ${operator.authUserId}::uuid,
           lifted_reason = ${params.reason}
     where id = ${params.suppressionId}::uuid and lifted_at is null
    returning address::text, organisation_id::text
  `;
  if (!lifted) throw invalid('That suppression is not in force.');

  await recordAudit(tx, {
    organisationId: lifted.organisation_id,
    actorUserId: operator.authUserId,
    action: 'platform.email.suppression_lifted',
    resourceType: 'email_suppression',
    resourceId: params.suppressionId,
    reason: params.reason,
    before: { suppressed: true },
    after: { suppressed: false },
  });
}

/**
 * What a landlord may learn about their own residents' addresses.
 *
 * Through the definer function, which returns a generalised reason and only
 * for addresses on this organisation's own residents. A complaint reads as
 * "asked not to receive", which is true, actionable and names nobody.
 */
export async function residentAddressesInTrouble(
  tx: Sql,
  organisationId: string,
): Promise<Array<{ address: string; trouble: 'undeliverable' | 'asked_not_to_receive'; since: string }>> {
  const rows = await tx<{ address: string; trouble: string; since: string }[]>`
    select address::text, trouble, since::text
      from app.resident_addresses_in_trouble(${organisationId}::uuid)
  `;
  return rows.map((r) => ({
    address: r.address,
    trouble: r.trouble === 'asked_not_to_receive' ? 'asked_not_to_receive' : 'undeliverable',
    since: r.since,
  }));
}
