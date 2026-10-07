import type { Sql } from '@propertyos/db';
import { postInAppNotice } from '@propertyos/domain';
import { resolveEmailAdapter, type EmailOutcome } from '@propertyos/integrations';

/**
 * Telling a lease's residents something, by inbox and by email.
 *
 * One place, because three call sites needed the same four steps and had begun
 * to diverge: find the people on the lease, post the notice, attempt email,
 * report truthfully what each actually did.
 *
 * The honesty rule is the whole point of the return value. `sent` means a
 * provider acknowledged every message. A development sink, a failed send and a
 * partial send are all `not delivered`, with the adapter's own reason attached
 * so the operator can see why. Nothing here reports delivery it did not get.
 */
export type EmailStatus =
  | 'not attempted'
  | 'sent'
  | 'not delivered'
  /** Nobody on the lease has an address to write to. */
  | 'no address'
  /** They have an address, and asked not to be emailed. A different thing. */
  | 'opted out';

export interface NoticeDelivery {
  /** How many in-app notices were written. */
  inbox: number;
  email: EmailStatus;
  /** The adapter's reason when email did not go out. Safe to show an operator. */
  emailDetail: string | null;
  /**
   * How many people were emailed against their recorded preference.
   *
   * Only an overriding notice produces a non-zero count, and the operator is
   * told: overriding someone's choice quietly is worse than not overriding it.
   */
  overrodePreference: number;
}

export interface LeaseRecipient {
  authUserId: string | null;
  email: string | null;
  /** Whether their recorded communication preference is email. */
  wantsEmail: boolean;
}

/**
 * The people with a live portal link to this lease, and where to reach them.
 *
 * The address comes from `portal_links.invited_email`, falling back to the
 * resident's current address — both organisation-scoped tables the operator can
 * read. It deliberately does NOT come from `user_profiles`: that table is
 * visible only to a person themselves and to their colleagues in a shared
 * organisation, and a resident is not a colleague, so reading it as the
 * operator returns null for every resident and silently produces "no address".
 */
async function leaseRecipients(
  tx: Sql, organisationId: string, leaseId: string,
): Promise<LeaseRecipient[]> {
  const rows = await tx<
    { auth_user_id: string | null; email: string | null; preference: string }[]
  >`
    select pl.auth_user_id,
           coalesce(rp.email, pl.invited_email)::text as email,
           coalesce(rp.communication_preference, 'email') as preference
      from portal_links pl
      left join resident_profiles rp
        on rp.organisation_id = pl.organisation_id and rp.id = pl.resident_id
     where pl.organisation_id = ${organisationId}::uuid
       and pl.lease_id = ${leaseId}::uuid
       and pl.status = 'active'
  `;
  return rows.map((r) => ({
    authUserId: r.auth_user_id,
    email: r.email,
    // 'in_app' and 'none' are choices the resident made. An ordinary notice
    // respects them; an overriding one does not, and says so.
    wantsEmail: r.preference === 'email',
  }));
}

export async function notifyLeaseResidents(
  tx: Sql,
  organisationId: string,
  notice: {
    leaseId: string;
    templateKey: string;
    title: string;
    body: string;
    linkPath?: string | null;
    /** Omit to post to the inbox only; email then reports 'not attempted'. */
    email?: {
      subject: string;
      body: string;
      /**
       * Email everyone on the lease regardless of their recorded preference.
       *
       * For the small number of notices a resident needs to receive whether or
       * not they like email — a lease ending is the one the product has. It is
       * not a licence to ignore the preference generally: every other notice
       * leaves this unset, and the override is counted and shown to the
       * operator rather than applied silently.
       */
      overridePreference?: boolean;
    };
  },
): Promise<NoticeDelivery> {
  const recipients = await leaseRecipients(tx, organisationId, notice.leaseId);

  const { posted } = await postInAppNotice(tx, organisationId, {
    recipientUserIds: recipients
      .map((r) => r.authUserId)
      .filter((id): id is string => Boolean(id)),
    templateKey: notice.templateKey,
    title: notice.title,
    body: notice.body,
    linkPath: notice.linkPath ?? null,
  });

  if (!notice.email) {
    return { inbox: posted, email: 'not attempted', emailDetail: null, overrodePreference: 0 };
  }

  const { addresses, overrodePreference, optedOut } =
    chooseEmailRecipients(recipients, notice.email.overridePreference === true);
  if (addresses.length === 0) {
    // Telling the operator "no email address on file" when the resident has one
    // and chose not to be written to sends them hunting for a missing address.
    return {
      inbox: posted,
      email: optedOut > 0 ? 'opted out' : 'no address',
      emailDetail: null,
      overrodePreference: 0,
    };
  }

  const adapter = resolveEmailAdapter();
  const outcomes = await Promise.all(addresses.map((to) => adapter.send({
    to,
    subject: notice.email!.subject,
    body: notice.email!.body,
    templateKey: notice.templateKey,
  })));

  return { inbox: posted, overrodePreference, ...summariseEmail(outcomes) };
}

/**
 * Turns adapter outcomes into what the operator is told.
 *
 * Exported so the honesty rule is testable on its own: `sent` requires EVERY
 * message to have been acknowledged by a provider. One sink, one failure, or a
 * partial send is `not delivered`, and the adapter's own reason comes with it.
 */
export function summariseEmail(
  outcomes: EmailOutcome[],
): { email: EmailStatus; emailDetail: string | null } {
  if (outcomes.length === 0) return { email: 'no address', emailDetail: null };
  if (outcomes.every((o) => o.status === 'sent')) return { email: 'sent', emailDetail: null };

  const problem = outcomes.find((o) => o.status !== 'sent');
  const detail = problem?.status === 'development_sink' ? problem.reason
    : problem?.status === 'failed' ? problem.error
    : null;
  return { email: 'not delivered', emailDetail: detail };
}

/**
 * Who gets the email, and whose choice that overrode.
 *
 * Without an override, only a resident whose recorded preference is email is
 * written to; 'in_app' and 'none' are respected. With one — which is for a lease
 * ending, and nothing else — everyone with an address is written to, and the
 * number of people whose preference that overrode comes back so the operator can
 * be told.
 *
 * Pure, and exported, because this is the rule most likely to be loosened by
 * accident later.
 */
export function chooseEmailRecipients(
  recipients: LeaseRecipient[],
  override: boolean,
): { addresses: string[]; overrodePreference: number; optedOut: number } {
  const reachable = recipients.filter((r) => Boolean(r.email));
  const chosen = override ? reachable : reachable.filter((r) => r.wantsEmail);
  return {
    addresses: [...new Set(chosen.map((r) => r.email!))],
    // Both counted on people, not addresses: it is a person's choice at stake,
    // and two of them can share one mailbox.
    overrodePreference: override ? chosen.filter((r) => !r.wantsEmail).length : 0,
    optedOut: override ? 0 : reachable.filter((r) => !r.wantsEmail).length,
  };
}
