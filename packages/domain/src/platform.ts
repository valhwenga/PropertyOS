import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, invalid, notFound } from './errors';

/**
 * Spike platform administration.
 *
 * The trust rule for this whole module: being a Spike operator grants NO access
 * to customer content. It grants access to platform METADATA — organisation
 * status, plan, usage counts, service health. Reaching actual customer records
 * additionally requires a support session the customer authorised, which is time
 * limited, read-only and audited.
 *
 * Every function here therefore does one of two things:
 *   * operates on platform metadata, gated on `is_platform_operator`; or
 *   * operates on a support session, which is itself the auditable artefact.
 */

export interface PlatformOperator {
  authUserId: string;
  fullName: string;
}

/**
 * Confirms the caller is Spike staff AND has verified a second factor.
 *
 * Checked through `app.is_platform_operator()`, the same MFA-gated function the
 * Row Level Security policies use, so the command layer and the database agree.
 * A staff member without a second factor is told to complete it rather than
 * being shown an empty console, which would read as a bug.
 *
 * Says nothing about customer access: that still needs a support session.
 */
export async function requirePlatformOperator(tx: Sql, authUserId: string): Promise<PlatformOperator> {
  const [row] = await tx<
    { full_name: string | null; is_staff: boolean; assured: boolean }[]
  >`
    select
      (select full_name from user_profiles where auth_user_id = ${authUserId}::uuid) as full_name,
      exists (
        select 1 from user_profiles
        where auth_user_id = ${authUserId}::uuid and is_platform_operator
      ) as is_staff,
      app.is_platform_operator() as assured
  `;
  if (!row?.is_staff) {
    throw new DomainError('forbidden', 'This area is restricted to Spike platform operators.');
  }
  if (!row.assured) {
    throw new DomainError(
      'forbidden',
      'Platform administration requires a verified second factor. Sign in again and complete your authenticator step.',
      { reason: 'mfa_required' },
    );
  }
  return { authUserId, fullName: row.full_name ?? 'Spike operator' };
}

export interface CustomerSummary {
  organisationId: string;
  name: string;
  slug: string;
  status: string;
  countryCode: string;
  currencyCode: string;
  timeZone: string;
  createdAt: string;
  planKey: string | null;
  subscriptionStatus: string | null;
  includedUnits: number | null;
  /** Billable units: every non-archived rentable unit, including vacant ones. */
  billableUnits: number;
  memberCount: number;
  activeLeases: number;
  overPlanLimit: boolean;
  activeSupportSessions: number;
}

/**
 * Lists customer organisations with platform metadata only.
 *
 * Deliberately returns NO resident names, lease details, balances or documents.
 * A Spike operator browsing this list learns how big a customer is and whether
 * their subscription is healthy — not who lives where or what they owe.
 */
export async function listCustomers(
  tx: Sql,
  authUserId: string,
): Promise<CustomerSummary[]> {
  await requirePlatformOperator(tx, authUserId);

  // Account metadata comes from the organisations/subscriptions tables, which a
  // platform operator can read. USAGE comes from app.platform_customer_usage(),
  // which returns counts only — there is no column in it through which a
  // resident name, a balance or a document could escape.
  const rows = await tx<
    { id: string; name: string; slug: string; status: string; country_code: string;
      currency_code: string; time_zone: string; created_at: string;
      plan_key: string | null; subscription_status: string | null; included_units: number | null;
      billable_units: number; member_count: number; active_leases: number;
      active_support_sessions: string }[]
  >`
    select o.id, o.name, o.slug, o.status::text, o.country_code, o.currency_code,
           o.time_zone, o.created_at::text,
           s.plan_key, s.status as subscription_status, pl.included_units,
           coalesce(usage.billable_units, 0) as billable_units,
           coalesce(usage.member_count, 0) as member_count,
           coalesce(usage.active_leases, 0) as active_leases,
           (select count(*) from support_sessions ss
             where ss.organisation_id = o.id and ss.revoked_at is null
               and ss.expires_at > now())::text as active_support_sessions
    from organisations o
    left join subscriptions s on s.organisation_id = o.id
    left join plans pl on pl.key = s.plan_key
    left join app.platform_customer_usage() usage on usage.organisation_id = o.id
    order by o.created_at desc
  `;

  return rows.map((r) => {
    const billable = Number(r.billable_units);
    return {
      organisationId: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      countryCode: r.country_code,
      currencyCode: r.currency_code,
      timeZone: r.time_zone,
      createdAt: r.created_at,
      planKey: r.plan_key,
      subscriptionStatus: r.subscription_status,
      includedUnits: r.included_units,
      billableUnits: billable,
      memberCount: Number(r.member_count),
      activeLeases: Number(r.active_leases),
      overPlanLimit: r.included_units !== null && billable > r.included_units,
      activeSupportSessions: Number(r.active_support_sessions),
    };
  });
}

export const provisionCustomerSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
  legalEntityName: z.string().trim().min(2).max(200),
  adminEmail: z.string().trim().email(),
  adminFullName: z.string().trim().min(2).max(200),
  planKey: z.string().default('starter'),
  countryCode: z.string().length(2).toUpperCase().default('ZA'),
  currencyCode: z.string().length(3).toUpperCase().default('ZAR'),
  timeZone: z.string().default('Africa/Johannesburg'),
});

export type ProvisionCustomerInput = z.infer<typeof provisionCustomerSchema>;

/** Changes a customer's plan. Does not touch any customer record. */
export async function changePlan(
  tx: Sql,
  authUserId: string,
  params: { organisationId: string; planKey: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformOperator(tx, authUserId);
  if (params.reason.trim().length < 5) throw invalid('A plan change requires a reason.');

  const [plan] = await tx<{ key: string; included_units: number }[]>`
    select key, included_units from plans where key = ${params.planKey} and is_active
  `;
  if (!plan) throw notFound('Plan');

  const [before] = await tx<{ plan_key: string }[]>`
    select plan_key from subscriptions where organisation_id = ${params.organisationId}::uuid
  `;
  if (!before) throw notFound('Subscription');

  await tx`
    update subscriptions set plan_key = ${params.planKey}, updated_at = now()
    where organisation_id = ${params.organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId: params.organisationId,
    actorUserId: operator.authUserId,
    action: 'platform.plan.changed',
    resourceType: 'subscription',
    resourceId: params.organisationId,
    reason: params.reason,
    before: { planKey: before.plan_key },
    after: { planKey: params.planKey },
  });
}

/**
 * Suspends or reactivates a customer account.
 *
 * Suspension stops access. It deliberately does NOT delete properties, contracts
 * or financial records: "do not treat account suspension as deletion of
 * properties, contracts or financial records."
 */
export async function setAccountStatus(
  tx: Sql,
  authUserId: string,
  params: { organisationId: string; status: 'trial' | 'active' | 'suspended' | 'closed'; reason: string },
): Promise<void> {
  const operator = await requirePlatformOperator(tx, authUserId);
  if (params.reason.trim().length < 5) throw invalid('An account status change requires a reason.');

  const [before] = await tx<{ status: string }[]>`
    select status::text from organisations where id = ${params.organisationId}::uuid
  `;
  if (!before) throw notFound('Organisation');

  await tx`
    update organisations set status = ${params.status}, updated_at = now()
    where id = ${params.organisationId}::uuid
  `;

  await recordAudit(tx, {
    organisationId: params.organisationId,
    actorUserId: operator.authUserId,
    action: 'platform.account.status_changed',
    resourceType: 'organisation',
    resourceId: params.organisationId,
    reason: params.reason,
    before: { status: before.status },
    after: { status: params.status },
  });
  await emitEvent(tx, {
    organisationId: params.organisationId,
    eventType: 'platform.account.status_changed',
    resourceType: 'organisation',
    resourceId: params.organisationId,
    payload: { from: before.status, to: params.status },
  });
}

/**
 * Requests a support session.
 *
 * Creating the session is itself the audited event. The session is read-only,
 * time limited, and must name a reason — there is no path to a permanent
 * all-customer role anywhere in this codebase.
 *
 * `authorisedBy` records WHO at the customer approved it. A session created
 * without customer authorisation is still bounded and audited, but it is
 * recorded as such so a review can find it.
 */
export async function openSupportSession(
  tx: Sql,
  authUserId: string,
  params: {
    organisationId: string;
    reason: string;
    hours: number;
    authorisedByUserId?: string;
  },
): Promise<{ supportSessionId: string; expiresAt: Date }> {
  const operator = await requirePlatformOperator(tx, authUserId);
  if (params.reason.trim().length < 10) {
    throw invalid('A support session requires a reason of at least 10 characters, including the ticket reference.');
  }
  if (params.hours < 1 || params.hours > 24) {
    throw invalid('A support session may last between 1 and 24 hours.');
  }

  const expiresAt = new Date(Date.now() + params.hours * 3_600_000);
  const [session] = await tx<{ id: string }[]>`
    insert into support_sessions (
      organisation_id, operator_user_id, reason, authorised_by, expires_at, read_only
    ) values (
      ${params.organisationId}, ${operator.authUserId}, ${params.reason},
      ${params.authorisedByUserId ?? null}, ${expiresAt.toISOString()}, true
    )
    returning id
  `;
  if (!session) throw new DomainError('internal', 'Support session insert returned no row.');

  await recordAudit(tx, {
    organisationId: params.organisationId,
    actorUserId: operator.authUserId,
    action: 'platform.support_session.opened',
    resourceType: 'support_session',
    resourceId: session.id,
    reason: params.reason,
    supportSessionId: session.id,
    after: {
      expiresAt: expiresAt.toISOString(),
      readOnly: true,
      customerAuthorised: Boolean(params.authorisedByUserId),
    },
  });
  // The customer is notified that their data was accessed.
  await emitEvent(tx, {
    organisationId: params.organisationId,
    eventType: 'platform.support_session.opened',
    resourceType: 'support_session',
    resourceId: session.id,
    payload: { expiresAt: expiresAt.toISOString(), readOnly: true },
  });

  return { supportSessionId: session.id, expiresAt };
}

export async function closeSupportSession(
  tx: Sql,
  authUserId: string,
  params: { supportSessionId: string },
): Promise<void> {
  const [session] = await tx<{ id: string; organisation_id: string }[]>`
    select id, organisation_id from support_sessions
    where id = ${params.supportSessionId}::uuid and revoked_at is null
  `;
  if (!session) throw notFound('Support session');

  await tx`
    update support_sessions set revoked_at = now() where id = ${params.supportSessionId}::uuid
  `;
  await recordAudit(tx, {
    organisationId: session.organisation_id,
    actorUserId: authUserId,
    action: 'platform.support_session.closed',
    resourceType: 'support_session',
    resourceId: session.id,
    supportSessionId: session.id,
  });
}

/** The access log a CUSTOMER sees: who at Spike looked at their data, and why. */
export async function supportAccessHistory(
  tx: Sql,
  organisationId: string,
): Promise<Array<{
  id: string; operatorName: string; reason: string; grantedAt: string;
  expiresAt: string; revokedAt: string | null; readOnly: boolean;
  authorisedByName: string | null; actionsRecorded: number;
}>> {
  const rows = await tx<
    { id: string; operator_name: string; reason: string; granted_at: string; expires_at: string;
      revoked_at: string | null; read_only: boolean; authorised_by_name: string | null;
      actions_recorded: string }[]
  >`
    select s.id, s.reason, s.granted_at::text, s.expires_at::text, s.revoked_at::text, s.read_only,
           op.full_name as operator_name,
           auth_by.full_name as authorised_by_name,
           (select count(*) from audit_events ae where ae.support_session_id = s.id)::text as actions_recorded
    from support_sessions s
    join user_profiles op on op.auth_user_id = s.operator_user_id
    left join user_profiles auth_by on auth_by.auth_user_id = s.authorised_by
    where s.organisation_id = ${organisationId}::uuid
    order by s.granted_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    operatorName: r.operator_name,
    reason: r.reason,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    readOnly: r.read_only,
    authorisedByName: r.authorised_by_name,
    actionsRecorded: Number(r.actions_recorded),
  }));
}

/* ------------------------------------------------------------- entitlements */

export interface EntitlementCheck {
  feature: string;
  limit: number | null;
  used: number;
  withinLimit: boolean;
}

/**
 * Checks a plan entitlement.
 *
 * Entitlements shape what a customer may ADD; they never hide or delete data
 * they already have. Exceeding a limit blocks creating the next unit, it does
 * not make existing units invisible or stop rent being recorded — billing
 * correctness is never collateral damage of a commercial limit.
 */
export async function checkEntitlement(
  tx: Sql,
  organisationId: string,
  feature: 'billable_units' | 'staff_accounts' | 'documents_gb',
): Promise<EntitlementCheck> {
  const [plan] = await tx<{ included_units: number | null; limit_value: number | null }[]>`
    select p.included_units,
           (select e.limit_value from plan_entitlements e
            where e.plan_key = p.key and e.feature = ${feature}) as limit_value
    from subscriptions s
    join plans p on p.key = s.plan_key
    where s.organisation_id = ${organisationId}::uuid
  `;

  let used = 0;
  if (feature === 'billable_units') {
    const [row] = await tx<{ count: string }[]>`
      select count(*)::text from units
      where organisation_id = ${organisationId}::uuid and status = 'active'
    `;
    used = Number(row?.count ?? 0);
  } else if (feature === 'staff_accounts') {
    const [row] = await tx<{ count: string }[]>`
      select count(*)::text from memberships
      where organisation_id = ${organisationId}::uuid and status in ('active', 'invited')
    `;
    used = Number(row?.count ?? 0);
  } else {
    const [row] = await tx<{ bytes: string }[]>`
      select coalesce(sum(byte_size), 0)::text as bytes from documents
      where organisation_id = ${organisationId}::uuid and deleted_at is null
    `;
    used = Math.ceil(Number(row?.bytes ?? 0) / (1024 * 1024 * 1024));
  }

  const limit = feature === 'billable_units' ? (plan?.included_units ?? null) : (plan?.limit_value ?? null);
  return { feature, limit, used, withinLimit: limit === null || used <= limit };
}

export async function requireEntitlement(
  tx: Sql,
  organisationId: string,
  feature: 'billable_units' | 'staff_accounts' | 'documents_gb',
): Promise<void> {
  const check = await checkEntitlement(tx, organisationId, feature);
  // `used` already counts existing records, so the next one must stay within.
  if (check.limit !== null && check.used >= check.limit) {
    throw new DomainError(
      'forbidden',
      `Your plan includes ${check.limit} ${check.feature.replace(/_/g, ' ')} and you are using ${check.used}. ` +
        'Upgrade your plan to add more. Your existing records are unaffected.',
      { feature: check.feature, limit: check.limit, used: check.used },
    );
  }
}

/** Platform service health, from the job queue and outbox. Carries no customer data. */
export async function platformHealth(
  tx: Sql,
  authUserId: string,
): Promise<{
  queuedJobs: number; runningJobs: number; deadJobs: number;
  unpublishedOutbox: number; oldestUnpublishedAt: string | null;
  failedNotifications: number; undeliveredNotifications: number;
}> {
  await requirePlatformOperator(tx, authUserId);
  const [row] = await tx<
    { queued_jobs: number; running_jobs: number; dead_jobs: number; unpublished_outbox: number;
      oldest_unpublished: string | null; failed_notifications: number;
      undelivered_notifications: number }[]
  >`select * from app.platform_health()`;

  return {
    queuedJobs: Number(row?.queued_jobs ?? 0),
    runningJobs: Number(row?.running_jobs ?? 0),
    deadJobs: Number(row?.dead_jobs ?? 0),
    unpublishedOutbox: Number(row?.unpublished_outbox ?? 0),
    oldestUnpublishedAt: row?.oldest_unpublished ?? null,
    failedNotifications: Number(row?.failed_notifications ?? 0),
    undeliveredNotifications: Number(row?.undelivered_notifications ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * System lease templates — the ones Spike publishes to every customer.
 *
 * Writes here are the ONE place a platform operator legitimately changes data,
 * because this is Spike's own content rather than a customer's. Customer tables
 * remain closed to them, with or without a support session.
 * ------------------------------------------------------------------ */

export interface SystemTemplateRow {
  id: string;
  name: string;
  provenance: string;
  summary: string;
  status: string;
  latestVersion: number | null;
  publishedVersion: number | null;
  updatedAt: string;
}

export async function listSystemLeaseTemplates(tx: Sql): Promise<SystemTemplateRow[]> {
  const rows = await tx<
    { id: string; name: string; provenance: string; summary: string; status: string;
      latest: number | null; published: number | null; updated_at: string }[]
  >`
    select t.id, t.name, t.provenance, t.summary, t.status::text, t.updated_at::text,
           (select max(version) from system_lease_template_versions v where v.template_id = t.id) as latest,
           (select max(version) from system_lease_template_versions v
             where v.template_id = t.id and v.published_at is not null) as published
    from system_lease_templates t
    order by t.name
  `;
  return rows.map((r) => ({
    id: r.id, name: r.name, provenance: r.provenance, summary: r.summary,
    status: r.status, latestVersion: r.latest, publishedVersion: r.published,
    updatedAt: r.updated_at,
  }));
}

export async function createSystemLeaseTemplate(
  tx: Sql,
  actorUserId: string,
  input: { name: string; provenance: string; summary: string; body: string },
): Promise<{ templateId: string }> {
  const name = input.name.trim();
  const provenance = input.provenance.trim();
  const body = input.body;
  if (!name) throw invalid('Give the template a name.');
  if (!provenance) {
    // Not optional. A landlord adopting wording needs to know where it came
    // from, and whether it was licensed to anyone.
    throw invalid('Record where this wording came from. Customers see it before adopting.');
  }
  if (body.trim().length < 200) {
    throw invalid('That body is too short to be a lease. Paste the full wording.');
  }

  const [template] = await tx<{ id: string }[]>`
    insert into system_lease_templates (name, layout, provenance, summary, status, created_by)
    values (${name}, 'inline', ${provenance}, ${input.summary.trim()}, 'draft', ${actorUserId})
    returning id
  `;
  if (!template) throw new DomainError('internal', 'Template insert returned no row.');

  await tx`
    insert into system_lease_template_versions (template_id, version, body, created_by)
    values (${template.id}, 1, ${body}, ${actorUserId})
  `;
  return { templateId: template.id };
}

/**
 * Publishes the latest draft version, which makes it visible to every customer.
 *
 * Publication is one-way for that version: the trigger refuses any later change
 * to it. Correcting published wording means publishing a new version, so a
 * customer can always see which text they adopted.
 */
export async function publishSystemLeaseTemplate(
  tx: Sql,
  actorUserId: string,
  params: { templateId: string },
): Promise<{ version: number }> {
  const [draft] = await tx<{ id: string; version: number }[]>`
    select id, version from system_lease_template_versions
    where template_id = ${params.templateId}::uuid and published_at is null
    order by version desc limit 1
  `;
  if (!draft) throw invalid('There is no unpublished version to publish.');

  await tx`
    update system_lease_template_versions
       set published_at = now(), published_by = ${actorUserId}
     where id = ${draft.id}::uuid
  `;
  await tx`
    update system_lease_templates
       set status = 'published', updated_at = now()
     where id = ${params.templateId}::uuid
  `;
  return { version: draft.version };
}

/** Adds a new draft version to an existing template. */
export async function addSystemLeaseTemplateVersion(
  tx: Sql,
  actorUserId: string,
  params: { templateId: string; body: string },
): Promise<{ version: number }> {
  if (params.body.trim().length < 200) {
    throw invalid('That body is too short to be a lease. Paste the full wording.');
  }
  const [latest] = await tx<{ version: number }[]>`
    select coalesce(max(version), 0) as version
    from system_lease_template_versions where template_id = ${params.templateId}::uuid
  `;
  const version = (latest?.version ?? 0) + 1;
  await tx`
    insert into system_lease_template_versions (template_id, version, body, created_by)
    values (${params.templateId}::uuid, ${version}, ${params.body}, ${actorUserId})
  `;
  return { version };
}
