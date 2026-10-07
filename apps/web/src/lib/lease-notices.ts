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
export type EmailStatus = 'not attempted' | 'sent' | 'not delivered' | 'no address';

export interface NoticeDelivery {
  /** How many in-app notices were written. */
  inbox: number;
  email: EmailStatus;
  /** The adapter's reason when email did not go out. Safe to show an operator. */
  emailDetail: string | null;
}

interface LeaseRecipient {
  authUserId: string | null;
  email: string | null;
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
    // The resident's recorded preference decides. 'in_app' and 'none' are
    // choices they made; emailing anyway would override them.
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
    email?: { subject: string; body: string };
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

  if (!notice.email) return { inbox: posted, email: 'not attempted', emailDetail: null };

  const addresses = [...new Set(
    recipients.filter((r) => r.wantsEmail).map((r) => r.email)
      .filter((e): e is string => Boolean(e)),
  )];
  if (addresses.length === 0) {
    return { inbox: posted, email: 'no address', emailDetail: null };
  }

  const adapter = resolveEmailAdapter();
  const outcomes = await Promise.all(addresses.map((to) => adapter.send({
    to,
    subject: notice.email!.subject,
    body: notice.email!.body,
    templateKey: notice.templateKey,
  })));

  return { inbox: posted, ...summariseEmail(outcomes) };
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
