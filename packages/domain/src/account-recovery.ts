import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { DomainError, forbidden, invalid, notFound, parsed } from './errors';
import { requirePermission } from './permissions';
import { requirePlatformPermission } from './platform';

/**
 * A way back into an account.
 *
 * There was none: multi-factor authentication is enforced, recovery codes are
 * shown once, there is deliberately no administrator reset and no Spike reset,
 * and there is no password reset anywhere in this product. A landlord who
 * forgets a password or loses a phone is locked out of their own tenancy
 * records for good, and the only fix is somebody with a database connection.
 *
 * The shape of what replaces that:
 *
 *   * a person ASKS, from a page they can reach while locked out;
 *   * somebody else DECIDES — the customer's own administrator where there is
 *     one, Spike only where there is not;
 *   * approval issues a single-use LINK rather than letting anybody in;
 *   * the link does only what was lost.
 *
 * What is not here, on purpose: any path by which a person recovers their own
 * account unaided, and any path by which one operator both decides and
 * delivers without the account holder being told.
 */

export type RecoveryLoss = 'password' | 'second_factor' | 'both';

export interface RecoveryRequestView {
  id: string;
  email: string;
  /** Null when no account has that address. Nothing anywhere tells the asker. */
  knownAccount: boolean;
  personName: string | null;
  organisations: string[];
  lost: RecoveryLoss;
  note: string | null;
  createdAt: string;
  status: 'open' | 'approved' | 'cancelled' | 'completed';
  decidedRoute: 'organisation' | 'spike' | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  effectiveAt: string | null;
  /** True once an approved link may actually be used. */
  live: boolean;
  tokenExpiresAt: string | null;
  cancellationReason: string | null;
  completedAt: string | null;
  /** Whether anybody but Spike could decide this one. */
  otherAdminExists: boolean;
}

const askSchema = z.object({
  email: z.string().trim().min(3).max(320),
  lost: z.enum(['password', 'second_factor', 'both']),
  note: z.string().trim().max(500).optional(),
  ipHash: z.string().optional(),
});

const digest = (token: string) => createHash('sha256').update(token).digest();
const mint = () => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: digest(token) };
};

/**
 * Asking, from outside the product.
 *
 * Runs anonymously and tells the caller nothing. The function behind it
 * records the request whether or not the address has an account, so the screen
 * can say one sentence in every case; a form that answers differently for a
 * real address is an account enumeration tool with a helpful tone.
 */
export async function requestAccountRecovery(
  tx: Sql,
  params: z.input<typeof askSchema>,
): Promise<void> {
  const input = parsed(askSchema, params);
  await tx`
    select app.request_account_recovery(
      ${input.email}, ${input.lost}, ${input.note ?? null}, ${input.ipHash ?? null}
    )
  `;
}

/**
 * The requests this caller is allowed to decide.
 *
 * One function for both sides, because the policies already say who sees what:
 * a customer's administrator sees the people in their own organisations, and
 * an operator sees only those with nobody else to ask.
 *
 * `onlyWithoutAnAdministrator` says the rule a second time, in SQL, for the
 * platform screen. That is not belt and braces for its own sake: several
 * platform pages read through `readPrivilegedAs`, which lifts row-level
 * filtering, and a rule that lives only in a policy would quietly stop
 * applying the day somebody reads this list that way. The test suite found
 * exactly that, because its own operator helper lifts filtering too.
 */
export async function listRecoveryRequests(
  tx: Sql,
  options: { includeSettled?: boolean; onlyWithoutAnAdministrator?: boolean } = {},
): Promise<RecoveryRequestView[]> {
  const rows = await tx<{
    id: string; email: string; auth_user_id: string | null; person_name: string | null;
    organisations: string[] | null; lost: RecoveryLoss; note: string | null;
    created_at: string; status: RecoveryRequestView['status'];
    decided_route: 'organisation' | 'spike' | null; decided_by_name: string | null;
    decided_at: string | null; decision_reason: string | null; effective_at: string | null;
    live: boolean; token_expires_at: string | null; cancellation_reason: string | null;
    completed_at: string | null; other_admin: boolean;
  }[]>`
    select r.id::text, r.email, r.auth_user_id::text, person.full_name as person_name,
           (select coalesce(array_agg(o.name order by o.name), '{}')
              from memberships m join organisations o on o.id = m.organisation_id
             where m.auth_user_id = r.auth_user_id and m.status = 'active') as organisations,
           r.lost, r.note, r.created_at::text, r.status, r.decided_route,
           decider.full_name as decided_by_name, r.decided_at::text, r.decision_reason,
           r.effective_at::text,
           (r.status = 'approved' and r.effective_at <= now() and r.token_expires_at > now())
             as live,
           r.token_expires_at::text, r.cancellation_reason, r.completed_at::text,
           coalesce(app.recovery_other_admin_exists(r.auth_user_id), false) as other_admin
    from recovery_requests r
    left join user_profiles person on person.auth_user_id = r.auth_user_id
    left join user_profiles decider on decider.auth_user_id = r.decided_by
    where ${options.includeSettled ? tx`true` : tx`r.status in ('open', 'approved')`}
      and ${options.onlyWithoutAnAdministrator
        ? tx`coalesce(app.recovery_other_admin_exists(r.auth_user_id), false) = false`
        : tx`true`}
    order by r.created_at desc
    limit 200
  `;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    knownAccount: row.auth_user_id !== null,
    personName: row.person_name,
    organisations: row.organisations ?? [],
    lost: row.lost,
    note: row.note,
    createdAt: row.created_at,
    status: row.status,
    decidedRoute: row.decided_route,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    effectiveAt: row.effective_at,
    live: row.live,
    tokenExpiresAt: row.token_expires_at,
    cancellationReason: row.cancellation_reason,
    completedAt: row.completed_at,
    otherAdminExists: row.other_admin,
  }));
}

/** The link, and for the Spike route the link that stops it. */
export interface RecoveryApproval {
  token: string;
  effectiveAt: string;
  tokenExpiresAt: string;
  /** Only for Spike's route: what the account holder uses to cancel. */
  cancelToken?: string;
}

async function loadOpen(tx: Sql, requestId: string) {
  const [row] = await tx<{
    id: string; auth_user_id: string | null; email: string; lost: RecoveryLoss; status: string;
  }[]>`
    select id::text, auth_user_id::text, email, lost, status
    from recovery_requests where id = ${requestId}::uuid
    for update
  `;
  // Not found and not-yours are the same answer: the policies decide
  // visibility, and an operator who can see a row they may not decide would
  // learn that the person has a colleague, which is not theirs to know.
  if (!row) throw notFound('Recovery request');
  if (row.status !== 'open') {
    throw invalid(`That request has already been ${row.status}.`);
  }
  if (!row.auth_user_id) {
    throw invalid(
      'There is no account with that address, so there is nothing to recover. '
      + 'Decline it and tell them which address they signed up with.',
    );
  }
  return row;
}

/**
 * The customer's own administrator deciding.
 *
 * Effective at once. The approver is the person who can tell whether this is
 * really their colleague, and they are not Spike — so there is nothing for a
 * waiting period to protect against that is not already true of every other
 * thing `membership.manage` lets them do.
 *
 * Two limits on it, both deliberate.
 *
 * It refuses to recover a **Spike operator's** account. Spike is a member of
 * nothing, so today no operator could be the subject here; if one ever were,
 * this route would let a customer's administrator take over a platform
 * account, and a guard that costs one query is worth having before that is
 * somebody's discovery.
 *
 * And the person whose account it is gets a notice. One administrator
 * approving a recovery for another administrator's login IS a takeover, and
 * what stands against it is not prevention — they already hold the same
 * permissions — but the fact that it is recorded against their name and that
 * the account holder is told it happened.
 */
export async function approveRecoveryAsAdministrator(
  tx: Sql,
  authUserId: string,
  params: { requestId: string; reason: string },
): Promise<RecoveryApproval> {
  if (params.reason.trim().length < 5) {
    throw invalid('Say how you know this is really them. It is recorded against your name.');
  }
  const request = await loadOpen(tx, params.requestId);

  const [subject] = await tx<{ is_operator: boolean }[]>`
    select coalesce(is_platform_operator, false) as is_operator
    from user_profiles where auth_user_id = ${request.auth_user_id}::uuid
  `;
  if (subject?.is_operator) {
    throw forbidden(
      'That account belongs to Spike staff and cannot be recovered from a customer '
      + 'organisation.',
    );
  }

  // The organisation this is being approved IN: one the caller administers and
  // the person belongs to. Checked here as well as in the policy so the person
  // gets a sentence rather than a row that refused to update.
  const [shared] = await tx<{ organisation_id: string }[]>`
    select m.organisation_id::text from memberships m
    where m.auth_user_id = ${request.auth_user_id}::uuid and m.status = 'active'
      and app.has_permission(m.organisation_id, 'membership.manage')
    limit 1
  `;
  if (!shared) {
    throw forbidden('Only an administrator of one of their organisations can approve this.');
  }
  await requirePermission(tx, shared.organisation_id, 'membership.manage');

  const { token, hash } = mint();
  const [approved] = await tx<{ effective_at: string; token_expires_at: string }[]>`
    update recovery_requests
       set status = 'approved', decided_route = 'organisation',
           decided_by = ${authUserId}::uuid, decided_at = now(),
           decision_reason = ${params.reason}, effective_at = now(),
           token_hash = ${hash}, token_expires_at = now() + interval '7 days'
     where id = ${params.requestId}::uuid and status = 'open'
    returning effective_at::text, token_expires_at::text
  `;
  if (!approved) throw forbidden('That request could not be approved.');

  // The account holder is told, whether or not they asked. If they did, it is
  // a confirmation; if they did not, it is the only warning they get that
  // somebody has been given a way into their account.
  await tx`
    insert into notifications (
      organisation_id, channel, recipient_user_id, recipient_email, title, subject, body,
      status
    ) values (
      ${shared.organisation_id}::uuid, 'email', ${request.auth_user_id}::uuid,
      ${request.email}, 'A recovery was approved for your account',
      'Your PropertyOS sign-in was reset',
      ${'An administrator of your organisation approved a request to reset the sign-in on '
        + 'your account and has been given a single-use link to send you. If you did not '
        + 'ask for this, tell them and Spike support at once: somebody else has been given '
        + 'a way into your account.'},
      'queued'
    )
  `;

  await recordAudit(tx, {
    organisationId: shared.organisation_id,
    actorUserId: authUserId,
    action: 'recovery.approved',
    resourceType: 'recovery_request',
    resourceId: params.requestId,
    reason: params.reason,
    before: { status: 'open' },
    after: { route: 'organisation', lost: request.lost },
  });

  return {
    token,
    effectiveAt: approved.effective_at,
    tokenExpiresAt: approved.token_expires_at,
  };
}

/**
 * Spike deciding, which it may only do when nobody else can.
 *
 * Two things make this safe enough to exist. The row is invisible to an
 * operator while the person has an administrator of their own, so this is the
 * solo landlord and nobody else. And it does not take effect immediately: the
 * delay is a window in which the account holder is told and can cancel it with
 * a link that works while they are locked out.
 *
 * The honest limit, which the screen states rather than hides: that protection
 * is only as good as the notice reaching them by some channel the operator does
 * not control. Until a mail provider is configured, the notice is queued and
 * not delivered, so the operator must tell them another way — and record how
 * they established who they were talking to.
 */
export async function approveRecoveryAsSpike(
  tx: Sql,
  authUserId: string,
  params: { requestId: string; reason: string },
): Promise<RecoveryApproval> {
  const operator = await requirePlatformPermission(
    tx, authUserId, 'platform.customers.recover',
  );
  if (params.reason.trim().length < 20) {
    throw invalid(
      'Record how you established who you were talking to — what you checked, and against '
      + 'what. This is the whole of the evidence that this was not a takeover.',
    );
  }
  const request = await loadOpen(tx, params.requestId);

  // Defence in depth: the policy already hides these rows, and a rule this
  // important should not rest on one expression in one policy.
  const [others] = await tx<{ other: boolean }[]>`
    select app.recovery_other_admin_exists(${request.auth_user_id}::uuid) as other
  `;
  if (others?.other) {
    throw forbidden(
      'Their own organisation has an administrator who can do this. Spike may only '
      + 'recover an account for somebody who has nobody else to ask.',
    );
  }

  const [delay] = await tx<{ hours: number }[]>`
    select app.setting_number('recovery.spike_delay_hours') as hours
  `;
  const hours = Number(delay?.hours ?? 24);
  const { token, hash } = mint();
  const cancel = mint();

  const [approved] = await tx<{ effective_at: string; token_expires_at: string }[]>`
    update recovery_requests
       set status = 'approved', decided_route = 'spike',
           decided_by = ${operator.authUserId}::uuid, decided_at = now(),
           decision_reason = ${params.reason},
           effective_at = now() + make_interval(hours => ${Number(hours)}),
           token_hash = ${hash}, cancel_token_hash = ${cancel.hash},
           token_expires_at = now() + make_interval(hours => ${Number(hours)})
             + interval '7 days'
     where id = ${params.requestId}::uuid and status = 'open'
    returning effective_at::text, token_expires_at::text
  `;
  if (!approved) throw forbidden('That request could not be approved.');

  // The notice, addressed to the person rather than to a template's idea of a
  // recipient. Queued against one of their organisations because that is what
  // `notifications` is keyed on; somebody who belongs to none gets no row, and
  // the screen says so.
  const [anyOrg] = await tx<{ organisation_id: string }[]>`
    select organisation_id::text from memberships
    where auth_user_id = ${request.auth_user_id}::uuid and status = 'active'
    limit 1
  `;
  if (anyOrg) {
    await tx`
      insert into notifications (
        organisation_id, channel, recipient_user_id, recipient_email, title, subject, body,
        status
      ) values (
        ${anyOrg.organisation_id}::uuid, 'email', ${request.auth_user_id}::uuid,
        ${request.email}, 'Somebody asked to reset your sign-in',
        'A recovery on your PropertyOS account',
        ${'Spike support approved a request to reset the sign-in on your account, because '
          + 'your organisation has no other administrator who could. It takes effect on '
          + `${approved.effective_at}. If this was not you, cancel it before then with the `
          + 'link in this message and tell Spike at once.'},
        'queued'
      )
    `;
  }

  await recordAudit(tx, {
    organisationId: anyOrg?.organisation_id ?? null,
    actorUserId: operator.authUserId,
    action: 'recovery.approved',
    resourceType: 'recovery_request',
    resourceId: params.requestId,
    reason: params.reason,
    before: { status: 'open' },
    after: {
      route: 'spike', lost: request.lost, effectiveAt: approved.effective_at,
      noticeQueued: Boolean(anyOrg),
    },
  });

  return {
    token,
    cancelToken: cancel.token,
    effectiveAt: approved.effective_at,
    tokenExpiresAt: approved.token_expires_at,
  };
}

/** Declining one, or stopping one already approved. */
export async function cancelRecovery(
  tx: Sql,
  authUserId: string,
  params: { requestId: string; reason: string },
): Promise<void> {
  if (params.reason.trim().length < 5) throw invalid('A decision needs a reason.');

  const [cancelled] = await tx<{ id: string }[]>`
    update recovery_requests
       set status = 'cancelled', cancelled_at = now(), cancelled_by = ${authUserId}::uuid,
           cancellation_reason = ${params.reason},
           token_hash = null, cancel_token_hash = null
     where id = ${params.requestId}::uuid and status in ('open', 'approved')
    returning id::text
  `;
  if (!cancelled) throw notFound('Recovery request');

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'recovery.cancelled',
    resourceType: 'recovery_request',
    resourceId: params.requestId,
    reason: params.reason,
    before: null,
    after: null,
  });
}

/**
 * The account holder stopping it, while still locked out.
 *
 * Runs on a privileged connection with the cancel token as the only
 * credential, exactly as a staff invitation is accepted. It is the reason the
 * delay on Spike's route protects anybody at all.
 */
export async function cancelRecoveryWithToken(
  tx: Sql,
  params: { cancelToken: string },
): Promise<void> {
  const [cancelled] = await tx<{ id: string }[]>`
    update recovery_requests
       set status = 'cancelled', cancelled_at = now(),
           cancellation_reason = 'Stopped by the account holder',
           token_hash = null, cancel_token_hash = null
     where cancel_token_hash = ${digest(params.cancelToken)} and status = 'approved'
    returning id::text
  `;
  if (!cancelled) {
    // Not `notFound()`: that helper builds "<thing> not found.", which read as
    // "...the recovery may have not found." on the page a locked-out person
    // sees.
    throw new DomainError(
      'not_found',
      'That link is not valid. It may have been used already, or the recovery may have '
      + 'been carried out or cancelled.',
    );
  }
  await recordAudit(tx, {
    organisationId: null,
    actorUserId: null,
    action: 'recovery.cancelled_by_holder',
    resourceType: 'recovery_request',
    resourceId: cancelled.id,
    reason: 'The account holder said it was not them.',
    before: null,
    after: null,
  });
}

export interface RecoveryLink {
  requestId: string;
  email: string;
  lost: RecoveryLoss;
  /** Set when the link is not usable yet, so the page can say when it will be. */
  effectiveAt: string;
  live: boolean;
}

const LINK_REFUSED =
  'This link is not valid. It may have expired, been used already, or been cancelled. '
  + 'Ask again from the sign-in page.';

/** What a link is for, before anybody types a new password into it. */
export async function describeRecoveryLink(
  tx: Sql,
  params: { token: string },
): Promise<RecoveryLink> {
  const [row] = await tx<{
    id: string; email: string; lost: RecoveryLoss; effective_at: string; live: boolean;
  }[]>`
    select id::text, email, lost, effective_at::text,
           (effective_at <= now() and token_expires_at > now()) as live
    from recovery_requests
    where token_hash = ${digest(params.token)} and status = 'approved'
  `;
  if (!row) throw new DomainError('not_found', LINK_REFUSED);
  return {
    requestId: row.id,
    email: row.email,
    lost: row.lost,
    effectiveAt: row.effective_at,
    live: row.live,
  };
}

/**
 * Spending the link.
 *
 * Does only what was lost. A forgotten password does not clear a second
 * factor — resetting the password leaves the authenticator in the way, which
 * is the point of having one — and a lost authenticator does not reset a
 * password.
 *
 * Clearing the factor takes the recovery codes with it: they were generated
 * alongside it and the person is about to be issued new ones when they enrol.
 * Signing in with no verified factor lands at `aal1`, so every MFA-gated
 * permission is refused until they do, which is the right end state rather
 * than a gap.
 */
export async function completeRecovery(
  tx: Sql,
  params: { token: string; newPasswordHash?: string },
): Promise<{ lost: RecoveryLoss; email: string }> {
  const hash = digest(params.token);
  const [row] = await tx<{
    id: string; auth_user_id: string; email: string; lost: RecoveryLoss;
  }[]>`
    select id::text, auth_user_id::text, email, lost
    from recovery_requests
    where token_hash = ${hash} and status = 'approved'
      and effective_at <= now() and token_expires_at > now()
    for update
  `;
  if (!row) throw new DomainError('not_found', LINK_REFUSED);

  const needsPassword = row.lost === 'password' || row.lost === 'both';
  if (needsPassword && !params.newPasswordHash) {
    throw invalid('A new password is needed.');
  }

  if (needsPassword) {
    await tx`
      update auth.users set password_hash = ${params.newPasswordHash!}
      where id = ${row.auth_user_id}::uuid
    `;
  }

  if (row.lost === 'second_factor' || row.lost === 'both') {
    await tx`
      delete from auth_mfa_factors where auth_user_id = ${row.auth_user_id}::uuid
    `;
    await tx`
      delete from auth_mfa_recovery_codes where auth_user_id = ${row.auth_user_id}::uuid
    `;
  }

  await tx`
    update recovery_requests
       set status = 'completed', completed_at = now(),
           token_hash = null, cancel_token_hash = null
     where id = ${row.id}::uuid
  `;

  const [anyOrg] = await tx<{ organisation_id: string }[]>`
    select organisation_id::text from memberships
    where auth_user_id = ${row.auth_user_id}::uuid and status = 'active'
    limit 1
  `;
  await recordAudit(tx, {
    organisationId: anyOrg?.organisation_id ?? null,
    actorUserId: row.auth_user_id,
    action: 'recovery.completed',
    resourceType: 'recovery_request',
    resourceId: row.id,
    reason: 'The approved recovery link was used.',
    before: null,
    after: { lost: row.lost },
  });

  return { lost: row.lost, email: row.email };
}
