import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { DomainError, notFound, parsed } from './errors';
import { recordAudit } from './audit';
import { requirePlatformOperator, provisionCustomer } from './platform';

/**
 * Landlords asking Spike for an account.
 *
 * The request is not a sign-up and this module does not pretend otherwise. No
 * email provider means an address here is unproven; no payment provider means
 * an account costs nothing to open. Either one alone would make unattended
 * organisation creation a way to fill the database with plausible rubbish, so
 * what the public form produces is a row in a queue, and the only thing that
 * creates an organisation is `provisionCustomer` — called by an operator, with
 * their second factor, writing the same audit entry as it always did.
 *
 * See docs/decisions/0020-asking-for-an-account.md.
 */

export interface SignupRequest {
  id: string;
  organisationName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  portfolioSize: number | null;
  note: string | null;
  status: 'requested' | 'provisioned' | 'declined';
  declineReason: string | null;
  organisationId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** A slug nobody has taken, offered as the default on the approval form. */
  suggestedSlug: string;
}

export const requestAccessSchema = z.object({
  organisationName: z.string().trim().min(2, 'Tell us what your business is called.').max(200),
  contactName: z.string().trim().min(2, 'Enter your name.').max(160),
  contactEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  contactPhone: z.string().trim().max(40).optional(),
  portfolioSize: z.number().int().min(0).max(1_000_000).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type RequestAccessInput = z.infer<typeof requestAccessSchema>;

/**
 * The public write, from a connection with no actor at all.
 *
 * Everything it does happens inside `app.request_platform_access`: the
 * application role holds no INSERT on the table, so there is no second path to
 * this row and no policy to widen by accident. The validation is duplicated
 * there, in SQL, because the function is the boundary and a caller that skips
 * this one must still be refused.
 */
export async function requestAccess(
  tx: Sql,
  input: RequestAccessInput,
  options: { ipHash?: string } = {},
): Promise<{ requestId: string }> {
  const details = parsed(requestAccessSchema, input);

  const [row] = await tx<{ id: string }[]>`
    select app.request_platform_access(
      ${details.organisationName},
      ${details.contactName},
      ${details.contactEmail},
      ${details.contactPhone ?? null},
      ${details.portfolioSize ?? null},
      ${details.note ?? null},
      ${options.ipHash ?? null}
    ) as id
  `;
  if (!row) throw new DomainError('internal', 'The request was not recorded.');
  return { requestId: row.id };
}

/** A starting point for the address, not a decision: the operator can change it. */
export function suggestSlug(organisationName: string): string {
  const base = organisationName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  // The slug pattern wants at least three characters and no leading digit-only
  // oddities; a name that reduces to nothing gets something typable instead.
  return base.length >= 3 ? base : `landlord-${base}`.slice(0, 50);
}

export async function listSignupRequests(
  tx: Sql,
  authUserId: string,
  options: { status?: 'requested' | 'provisioned' | 'declined' } = {},
): Promise<SignupRequest[]> {
  await requirePlatformOperator(tx, authUserId);

  const status = options.status ?? null;
  const rows = await tx<Array<{
    id: string; organisation_name: string; contact_name: string; contact_email: string;
    contact_phone: string | null; portfolio_size: number | null; note: string | null;
    status: SignupRequest['status']; decline_reason: string | null;
    organisation_id: string | null; created_at: string; decided_at: string | null;
  }>>`
    select id, organisation_name, contact_name, contact_email, contact_phone,
           portfolio_size, note, status, decline_reason, organisation_id,
           created_at::text, decided_at::text
      from signup_requests
     where ${status === null ? tx`true` : tx`status = ${status}`}
     order by created_at desc
     limit 500
  `;

  // Which of the suggested addresses are already somebody's. Asked once, and
  // in the same shape the suggestion is made, so the form never offers an
  // address that provisioning will then refuse.
  const suggestions = new Map(rows.map((r) => [r.id, suggestSlug(r.organisation_name)]));
  const wanted = [...new Set(suggestions.values())];
  const taken = new Set(
    wanted.length === 0 ? [] : (
      await tx<{ slug: string }[]>`
        select slug from organisations where slug = any(${wanted})
      `
    ).map((o) => o.slug),
  );

  return rows.map((r) => {
    const suggested = suggestions.get(r.id)!;
    return {
      id: r.id,
      organisationName: r.organisation_name,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      portfolioSize: r.portfolio_size,
      note: r.note,
      status: r.status,
      declineReason: r.decline_reason,
      organisationId: r.organisation_id,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      // A taken address is offered with a suffix rather than silently: the
      // operator sees what it will be before they submit.
      suggestedSlug: taken.has(suggested) ? `${suggested}-za`.slice(0, 50) : suggested,
    };
  });
}

/**
 * Approving one.
 *
 * This is `provisionCustomer` with the request's details pre-filled and the
 * row marked afterwards. It is not a second provisioning path: every check,
 * every clash rule and the audit entry are that function's, and if it refuses
 * the request stays open.
 *
 * MUST run on a transaction whose row filtering is lifted, for the reason
 * `provisionCustomer` already documents — the operator is deliberately a
 * member of no organisation.
 */
export async function approveSignupRequest(
  tx: Sql,
  authUserId: string,
  input: {
    requestId: string;
    slug: string;
    planKey: string;
    legalEntityName: string;
    /** Spike may correct an obviously mistyped trading name before it becomes a URL. */
    name?: string;
  },
): Promise<{ organisationId: string; token: string; expiresAt: Date }> {
  await requirePlatformOperator(tx, authUserId);

  const details = parsed(
    z.object({
      requestId: z.string().uuid(),
      slug: z.string().trim().min(3).max(50),
      planKey: z.string().trim().min(2).max(40),
      legalEntityName: z.string().trim().min(2).max(200),
      name: z.string().trim().min(2).max(200).optional(),
    }),
    input,
  );

  const [request] = await tx<Array<{
    id: string; organisation_name: string; contact_name: string; contact_email: string;
    status: string;
  }>>`
    select id, organisation_name, contact_name, contact_email, status
      from signup_requests where id = ${details.requestId}::uuid
      for update
  `;
  if (!request) throw notFound('Request');
  if (request.status !== 'requested') {
    throw new DomainError(
      'conflict',
      'That request has already been decided. Nothing was changed.',
    );
  }

  const provisioned = await provisionCustomer(tx, authUserId, {
    name: details.name ?? request.organisation_name,
    slug: details.slug,
    legalEntityName: details.legalEntityName,
    planKey: details.planKey,
    administrator: { fullName: request.contact_name, email: request.contact_email },
    reason: `Requested through the public form on ${new Date().toISOString().slice(0, 10)}.`,
  });

  await tx`
    update signup_requests
       set status = 'provisioned',
           organisation_id = ${provisioned.organisationId}::uuid,
           decided_by = ${authUserId}::uuid,
           decided_at = now()
     where id = ${details.requestId}::uuid
  `;

  return {
    organisationId: provisioned.organisationId,
    token: provisioned.token,
    expiresAt: provisioned.expiresAt,
  };
}

/**
 * Declining one.
 *
 * The reason is kept and nothing is sent: with no email provider there is no
 * honest way to tell them, so the queue records the decision rather than
 * implying a message went out.
 */
export async function declineSignupRequest(
  tx: Sql,
  authUserId: string,
  input: { requestId: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformOperator(tx, authUserId);
  const details = parsed(
    z.object({
      requestId: z.string().uuid(),
      reason: z.string().trim().min(5, 'Say why, so the queue is readable later.').max(500),
    }),
    input,
  );

  const updated = await tx<{ id: string }[]>`
    update signup_requests
       set status = 'declined',
           decline_reason = ${details.reason},
           decided_by = ${authUserId}::uuid,
           decided_at = now()
     where id = ${details.requestId}::uuid and status = 'requested'
     returning id
  `;
  if (updated.length === 0) {
    throw new DomainError(
      'conflict',
      'That request is no longer open. Nothing was changed.',
    );
  }

  // No organisation exists, so this is audited against none: `recordAudit`
  // takes the platform's own null-organisation form used elsewhere for
  // operator actions that precede an organisation.
  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.signup_request_declined',
    resourceType: 'signup_request',
    resourceId: details.requestId,
    reason: details.reason,
    after: { declinedBy: operator.fullName },
  });
}
