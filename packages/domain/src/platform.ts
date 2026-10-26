import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { recordAudit, emitEvent } from './audit';
import { DomainError, invalid, notFound, parsed } from './errors';
import { createOrganisationShell } from './organisations';

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

export type PlatformPermissionKey =
  | 'platform.customers.read'
  | 'platform.customers.provision'
  | 'platform.customers.plan'
  | 'platform.customers.status'
  | 'platform.support.request'
  | 'platform.billing.manage'
  | 'platform.templates.manage'
  | 'platform.operators.manage'
  | 'platform.permissions.manage'
  | 'platform.config.manage'
  | 'platform.audit.read';

export interface PlatformOperatorIdentity {
  authUserId: string;
  fullName: string;
  permissions: PlatformPermissionKey[];
}

/**
 * The console's authorisation check.
 *
 * Asks the database, through the same `app.platform_permission` function the
 * policies use, so a screen and a row never disagree about what somebody may
 * do. `requirePlatformOperator` still runs first: it is what reports a missing
 * second factor as a second factor rather than as a flat refusal.
 */
export async function requirePlatformPermission(
  tx: Sql,
  authUserId: string,
  permission: PlatformPermissionKey,
): Promise<PlatformOperatorIdentity> {
  const operator = await requirePlatformOperator(tx, authUserId);

  const [row] = await tx<{ allowed: boolean }[]>`
    select app.platform_permission(${permission}) as allowed
  `;
  if (!row?.allowed) {
    throw new DomainError(
      'forbidden',
      'Your platform role does not include this. An administrator can change it under Operators.',
      { reason: 'platform_permission_missing', permission },
    );
  }

  return { ...operator, permissions: await platformPermissionsOf(tx, authUserId) };
}

/** What this operator may do, for deciding what to offer them. */
export async function platformPermissionsOf(
  tx: Sql,
  authUserId: string,
): Promise<PlatformPermissionKey[]> {
  const rows = await tx<{ permission_key: PlatformPermissionKey }[]>`
    select distinct rp.permission_key
      from platform_operator_roles r
      join platform_role_permissions rp on rp.role_key = r.role_key
     where r.auth_user_id = ${authUserId}::uuid
     order by rp.permission_key
  `;
  return rows.map((r) => r.permission_key);
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
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');

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
    -- Name as the tie-break, not decoration: two organisations created in the
    -- same transaction share a created_at to the microsecond, and ordering by
    -- it alone lets Postgres return them in either order — so the customer list
    -- reshuffles between page loads and "the first customer" means nothing.
    order by o.created_at desc, o.name
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

export interface PlanRow {
  key: string;
  name: string;
  includedUnits: number;
  monthlyPriceMinor: number;
  additionalUnitPriceMinor: number;
  currencyCode: string;
  staffAccounts: number | null;
  documentsGb: number | null;
}

/** The plan catalogue. Readable by everybody: a price list is not a secret. */
export async function listPlans(tx: Sql): Promise<PlanRow[]> {
  const rows = await tx<
    { key: string; name: string; included_units: number; monthly_price_minor: string;
      additional_unit_price_minor: string; currency_code: string;
      staff_accounts: number | null; documents_gb: number | null }[]
  >`
    select p.key, p.name, p.included_units, p.monthly_price_minor::text,
           p.additional_unit_price_minor::text, p.currency_code,
           (select limit_value from plan_entitlements
             where plan_key = p.key and feature = 'staff_accounts') as staff_accounts,
           (select limit_value from plan_entitlements
             where plan_key = p.key and feature = 'documents_gb') as documents_gb
      from plans p
     where p.is_active
     order by p.included_units
  `;
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    includedUnits: r.included_units,
    monthlyPriceMinor: Number(r.monthly_price_minor),
    additionalUnitPriceMinor: Number(r.additional_unit_price_minor),
    currencyCode: r.currency_code,
    staffAccounts: r.staff_accounts,
    documentsGb: r.documents_gb,
  }));
}

export interface CustomerDetail {
  organisationId: string;
  name: string;
  slug: string;
  status: string;
  countryCode: string;
  currencyCode: string;
  timeZone: string;
  createdAt: string;
  plan: PlanRow | null;
  subscriptionStatus: string | null;
  /** Every non-archived rentable unit, vacant ones included. */
  billableUnits: number;
  /** Members with access. A colleague who has been invited but has not accepted is not one. */
  activeMembers: number;
  activeLeases: number;
  documentBytes: number;
  /** Units beyond the plan's allowance, which is what the overage price applies to. */
  unitsOverAllowance: number;
  /**
   * What this customer is worth per month at today's usage, in minor units:
   * the plan price plus the overage. Nothing bills from this — it is the
   * arithmetic an operator would otherwise do on paper, and no invoice to a
   * customer exists anywhere in this product yet.
   */
  monthlyChargeMinor: number | null;
  allowances: Array<{
    feature: 'billable_units' | 'staff_accounts' | 'documents_gb';
    label: string;
    used: number;
    limit: number | null;
    withinLimit: boolean;
  }>;
  supportSessions: Array<{
    id: string;
    operatorName: string;
    reason: string;
    grantedAt: string;
    expiresAt: string;
    revokedAt: string | null;
    readOnly: boolean;
    customerAuthorised: boolean;
    approvedByName: string | null;
    approvedViaWindow: boolean;
    actionsRecorded: number;
    openedByMe: boolean;
    /** Approved and live: this operator can read the customer's records now. */
    open: boolean;
    /** Asked for and not answered. It reaches nothing. */
    waiting: boolean;
  }>;
  /**
   * A window the customer has open, if any. Shown to an operator because
   * without it they cannot tell whether opening a session will reach anything
   * or sit waiting on somebody.
   */
  openWindow: {
    expiresAt: string; authorisedByName: string | null; reason: string;
    /** What the customer allowed changing in this window. Empty means reading only. */
    scopes: string[];
  } | null;
  platformActions: Array<{
    id: string;
    at: string;
    action: string;
    actorName: string | null;
    reason: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>;
}

/**
 * One customer, for the operator console.
 *
 * Carries the same promise as `listCustomers` and has to work harder to keep
 * it: usage comes from `app.platform_customer_usage()`, which returns counts
 * and a byte total and nothing else, because the underlying tables are closed
 * to an operator. Counting `units` directly here would read zero rows and
 * report an empty customer — correct row-level security, silently wrong number.
 *
 * `supportSessions` and `platformActions` are Spike's own conduct, readable
 * since migration 0064. Nothing in the return value names a resident, a
 * property, a balance or a document.
 */
export async function customerDetail(
  tx: Sql,
  authUserId: string,
  organisationId: string,
): Promise<CustomerDetail> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.read');

  const [row] = await tx<
    { id: string; name: string; slug: string; status: string; country_code: string;
      currency_code: string; time_zone: string; created_at: string;
      plan_key: string | null; subscription_status: string | null;
      billable_units: number; member_count: number; active_leases: number;
      document_bytes: string }[]
  >`
    select o.id, o.name, o.slug, o.status::text, o.country_code, o.currency_code,
           o.time_zone, o.created_at::text,
           s.plan_key, s.status as subscription_status,
           coalesce(u.billable_units, 0) as billable_units,
           coalesce(u.member_count, 0) as member_count,
           coalesce(u.active_leases, 0) as active_leases,
           coalesce(u.document_bytes, 0)::text as document_bytes
      from organisations o
      left join subscriptions s on s.organisation_id = o.id
      left join app.platform_customer_usage() u on u.organisation_id = o.id
     where o.id = ${organisationId}::uuid
  `;
  if (!row) throw notFound('Customer organisation');

  const plans = await listPlans(tx);
  const plan = plans.find((p) => p.key === row.plan_key) ?? null;
  const billableUnits = Number(row.billable_units);
  const activeMembers = Number(row.member_count);
  const documentBytes = Number(row.document_bytes);
  const documentsGb = Math.ceil(documentBytes / (1024 * 1024 * 1024));

  const unitsOverAllowance = plan ? Math.max(0, billableUnits - plan.includedUnits) : 0;

  const sessions = await tx<
    { id: string; operator_user_id: string; operator_name: string | null; reason: string;
      granted_at: string; expires_at: string; revoked_at: string | null;
      read_only: boolean; authorised_by: string | null; approved_at: string | null;
      approved_by_name: string | null; approved_via_grant_id: string | null;
      actions_recorded: string }[]
  >`
    select ss.id, ss.operator_user_id,
           (select full_name from user_profiles up where up.auth_user_id = ss.operator_user_id)
             as operator_name,
           ss.reason, ss.granted_at::text, ss.expires_at::text, ss.revoked_at::text,
           ss.read_only, ss.authorised_by::text, ss.approved_at::text,
           ss.approved_via_grant_id::text,
           -- The approver is the customer's own staff member. A platform
           -- operator cannot read that profile, so this is null for them and
           -- the screen says "approved" without a name rather than inventing
           -- one.
           (select full_name from user_profiles up where up.auth_user_id = ss.authorised_by)
             as approved_by_name,
           (select count(*) from audit_events ae where ae.support_session_id = ss.id)::text
             as actions_recorded
      from support_sessions ss
     where ss.organisation_id = ${organisationId}::uuid
     order by ss.granted_at desc
     limit 50
  `;

  const actions = await tx<
    { id: string; occurred_at: string; action: string; actor_name: string | null;
      reason: string | null; before_state: unknown; after_state: unknown }[]
  >`
    select ae.id, ae.occurred_at::text, ae.action,
           (select full_name from user_profiles up where up.auth_user_id = ae.actor_user_id)
             as actor_name,
           ae.reason, ae.before_state, ae.after_state
      from audit_events ae
     where ae.organisation_id = ${organisationId}::uuid
       and ae.action like 'platform.%'
     order by ae.occurred_at desc
     limit 50
  `;

  const [openWindow] = await tx<
    { expires_at: string; authorised_by_name: string | null; reason: string;
      scopes: string[] }[]
  >`
    select g.expires_at::text, g.reason, g.scopes,
           (select full_name from user_profiles up where up.auth_user_id = g.authorised_by)
             as authorised_by_name
      from support_access_grants g
     where g.organisation_id = ${organisationId}::uuid
       and g.revoked_at is null and g.expires_at > now()
     order by g.expires_at desc
     limit 1
  `;

  const now = Date.now();
  return {
    organisationId: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    timeZone: row.time_zone,
    createdAt: row.created_at,
    plan,
    subscriptionStatus: row.subscription_status,
    billableUnits,
    activeMembers,
    activeLeases: Number(row.active_leases),
    documentBytes,
    unitsOverAllowance,
    monthlyChargeMinor: plan
      ? plan.monthlyPriceMinor + unitsOverAllowance * plan.additionalUnitPriceMinor
      : null,
    allowances: [
      {
        feature: 'billable_units' as const,
        label: 'Units',
        used: billableUnits,
        limit: plan?.includedUnits ?? null,
        withinLimit: !plan || billableUnits <= plan.includedUnits,
      },
      {
        feature: 'staff_accounts' as const,
        label: 'Staff accounts',
        used: activeMembers,
        limit: plan?.staffAccounts ?? null,
        withinLimit: plan?.staffAccounts === null || plan?.staffAccounts === undefined
          || activeMembers <= plan.staffAccounts,
      },
      {
        feature: 'documents_gb' as const,
        label: 'Document storage (GB)',
        used: documentsGb,
        limit: plan?.documentsGb ?? null,
        withinLimit: plan?.documentsGb === null || plan?.documentsGb === undefined
          || documentsGb <= plan.documentsGb,
      },
    ],
    supportSessions: sessions.map((ss) => ({
      id: ss.id,
      operatorName: ss.operator_name ?? 'Spike operator',
      reason: ss.reason,
      grantedAt: ss.granted_at,
      expiresAt: ss.expires_at,
      revokedAt: ss.revoked_at,
      readOnly: ss.read_only,
      customerAuthorised: ss.authorised_by !== null,
      approvedByName: ss.approved_by_name,
      approvedViaWindow: ss.approved_via_grant_id !== null,
      actionsRecorded: Number(ss.actions_recorded),
      openedByMe: ss.operator_user_id === operator.authUserId,
      open: ss.approved_at !== null && ss.revoked_at === null
        && new Date(ss.expires_at).getTime() > now,
      waiting: ss.approved_at === null && ss.revoked_at === null
        && new Date(ss.expires_at).getTime() > now,
    })),
    openWindow: openWindow
      ? {
        expiresAt: openWindow.expires_at,
        authorisedByName: openWindow.authorised_by_name,
        reason: openWindow.reason,
        scopes: openWindow.scopes,
      }
      : null,
    platformActions: actions.map((a) => ({
      id: a.id,
      at: a.occurred_at,
      action: a.action,
      actorName: a.actor_name,
      reason: a.reason,
      before: (a.before_state as Record<string, unknown> | null) ?? null,
      after: (a.after_state as Record<string, unknown> | null) ?? null,
    })),
  };
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
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.plan');
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
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.status');
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
 * Asks for a support session.
 *
 * Asking, not taking. Since migration 0065 the session this creates reaches
 * NOTHING until the customer approves it — `app.support_organisation_ids()`
 * excludes an unapproved one, so every read policy in the schema returns no
 * rows rather than a filtered subset. Before that, an operator inserted a row
 * for themselves and read the customer's records at once, while
 * `authorised_by` sat null and the customer's own screen said "Not authorised
 * by you" against every session there had ever been.
 *
 * The one exception is not an exception to the rule: if the customer has an
 * open window (`support_access_grants`), the session is approved on arrival and
 * records which window admitted it, so the trail still answers who let support
 * in and when they decided to.
 *
 * There is no path here that approves a session on Spike's own say-so. An
 * operator who could do that in an emergency could do it at any time.
 */
/** When a window closes, as epoch milliseconds. */
async function windowExpiry(tx: Sql, grantId: string): Promise<number> {
  const [row] = await tx<{ expires_at: string }[]>`
    select expires_at::text from support_access_grants where id = ${grantId}::uuid
  `;
  return row ? new Date(row.expires_at).getTime() : Date.now();
}

export async function openSupportSession(
  tx: Sql,
  authUserId: string,
  params: {
    organisationId: string;
    reason: string;
    hours: number;
    /**
     * What the operator needs to be able to DO, if anything.
     *
     * Honoured only against a window the customer already opened carrying
     * those scopes, and narrowed to that window's own — asking for more than
     * was given yields a session that can read and nothing else. Without a
     * window the session is read-only whatever is asked for here, and the
     * customer chooses the scopes when they approve it: a request is not a
     * negotiation the operator can win.
     */
    scopes?: string[];
  },
): Promise<{
  supportSessionId: string; expiresAt: Date; approved: boolean; scopes: string[];
}> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.support.request');
  if (params.reason.trim().length < 10) {
    throw invalid('A support session requires a reason of at least 10 characters, including the ticket reference.');
  }
  if (params.hours < 1 || params.hours > 24) {
    throw invalid('A support session may last between 1 and 24 hours.');
  }

  const expiresAt = new Date(Date.now() + params.hours * 3_600_000);

  // A window the customer opened in advance approves this session as it is
  // created. The narrowest live one is used — not the longest — so a session
  // can never outlast the permission that admitted it.
  const [openWindow] = await tx<{ id: string; authorised_by: string; scopes: string[] }[]>`
    select id, authorised_by::text, scopes from support_access_grants
     where organisation_id = ${params.organisationId}::uuid
       and revoked_at is null
       and expires_at > now()
     order by expires_at
     limit 1
  `;
  const approvedWindow = openWindow ?? null;
  // The session cannot outlive the window that approved it.
  const effectiveExpiry = approvedWindow
    ? new Date(Math.min(
      expiresAt.getTime(),
      await windowExpiry(tx, approvedWindow.id),
    ))
    : expiresAt;

  // The intersection, never the request: a window carrying 'maintenance'
  // answers an operator asking for 'records' with read access only.
  const scopes = approvedWindow
    ? (params.scopes ?? []).filter((scope) => approvedWindow.scopes.includes(scope))
    : [];

  const [session] = await tx<{ id: string }[]>`
    insert into support_sessions (
      organisation_id, operator_user_id, reason, authorised_by, expires_at, read_only,
      approved_at, approved_via_grant_id, scopes
    ) values (
      ${params.organisationId}, ${operator.authUserId}, ${params.reason},
      ${approvedWindow?.authorised_by ?? null},
      ${effectiveExpiry.toISOString()}, ${scopes.length === 0},
      ${approvedWindow ? new Date().toISOString() : null}, ${approvedWindow?.id ?? null},
      ${scopes}
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
      expiresAt: effectiveExpiry.toISOString(),
      readOnly: scopes.length === 0,
      scopes,
      approved: approvedWindow !== null,
      approvedViaWindow: approvedWindow?.id ?? null,
    },
  });
  // The customer is told either that their data was accessed, or that
  // somebody is waiting on them — which is the more urgent of the two.
  await emitEvent(tx, {
    organisationId: params.organisationId,
    eventType: approvedWindow
      ? 'platform.support_session.opened'
      : 'platform.support_session.requested',
    resourceType: 'support_session',
    resourceId: session.id,
    payload: {
      expiresAt: effectiveExpiry.toISOString(),
      readOnly: scopes.length === 0,
      scopes,
      approved: approvedWindow !== null,
    },
  });

  return {
    supportSessionId: session.id,
    expiresAt: effectiveExpiry,
    approved: approvedWindow !== null,
    scopes,
  };
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

  // `returning` is the point of this, not decoration. Row-level security
  // decides whether this UPDATE may touch the row, and a policy that refuses
  // makes it affect NOTHING rather than raise — so without the check, a
  // customer administrator who lacked `support.access.manage` would be told
  // their revoke succeeded while Spike's access continued. Revoking is the one
  // control the whole support-session design rests on; it may not fail quietly.
  const affected = await tx<{ id: string }[]>`
    update support_sessions set revoked_at = now()
    where id = ${params.supportSessionId}::uuid and revoked_at is null
    returning id
  `;
  if (affected.length === 0) {
    throw new DomainError(
      'forbidden',
      'You cannot close this support session. Revoking Spike support access needs an '
        + 'administrator of the organisation it was opened against, or the operator who opened it.',
    );
  }

  await recordAudit(tx, {
    organisationId: session.organisation_id,
    actorUserId: authUserId,
    action: 'platform.support_session.closed',
    resourceType: 'support_session',
    resourceId: session.id,
    supportSessionId: session.id,
  });
}

/* Entitlements live in ./entitlements, and are re-exported from the package
 * index beside these. The enforcement points are in customer code. */

/** Platform service health, from the job queue and outbox. Carries no customer data. */
export async function platformHealth(
  tx: Sql,
  authUserId: string,
): Promise<{
  queuedJobs: number; runningJobs: number; deadJobs: number;
  unpublishedOutbox: number; oldestUnpublishedAt: string | null;
  failedNotifications: number; undeliveredNotifications: number;
}> {
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');
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
  await requirePlatformPermission(tx, actorUserId, 'platform.templates.manage');
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
): Promise<{ version: number; notified: { organisations: number; people: number } }> {
  await requirePlatformPermission(tx, actorUserId, 'platform.templates.manage');
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

  const notified = await notifyAdopters(tx, params.templateId, draft.version);
  return { version: draft.version, notified };
}

/**
 * Tells the organisations that adopted this template that a newer version exists.
 *
 * It does NOT change their wording. An adopted template is a copy and stays
 * exactly as they left it — silently editing text on a lease someone has signed
 * would be indefensible. This is the alternative: they are told, and they decide.
 *
 * Delegated to app.notify_template_adopters, which runs as its owner, because a
 * Spike operator has no read access to customer content and a query run in their
 * context would find no adopters and silently deliver nothing. The function
 * returns COUNTS only: the operator learns how many were told, never which
 * customers use the template or who they are. Acting on a customer's behalf is
 * not the same as reading their records.
 *
 * Only roles that can actually manage templates are told. A notice someone
 * cannot act on is noise, and noise teaches people to ignore notices.
 */
async function notifyAdopters(
  tx: Sql,
  templateId: string,
  version: number,
): Promise<{ organisations: number; people: number }> {
  const [row] = await tx<{ organisations: number; people: number }[]>`
    select organisations, people from app.notify_template_adopters(
      ${templateId}::uuid, ${version}::integer
    )
  `;
  return { organisations: row?.organisations ?? 0, people: row?.people ?? 0 };
}


/** Adds a new draft version to an existing template. */
export async function addSystemLeaseTemplateVersion(
  tx: Sql,
  actorUserId: string,
  params: { templateId: string; body: string },
): Promise<{ version: number }> {
  await requirePlatformPermission(tx, actorUserId, 'platform.templates.manage');
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

/* -------------------------------------------------------------------------- */
/* Provisioning a customer                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sets up a new customer organisation.
 *
 * `createOrganisationWithOwner` has existed since the first migration and had
 * no screen, so a new customer could not be set up in the product at all —
 * every organisation that exists was created by the seed or by a test.
 *
 * The important decision here is what Spike does NOT get. The obvious
 * implementation makes the Spike operator the founding administrator and
 * expects somebody to remove them afterwards; that is a Spike account inside
 * customer data, which is exactly what the support-session machinery exists to
 * avoid. So a provisioned organisation starts with NOBODY in it. Its founding
 * administrator arrives by accepting an invitation, the same mechanism a
 * customer uses for their own colleagues, and until they do the organisation
 * is an empty shell that no Spike operator can read either.
 *
 * The invitation row is written here rather than through `inviteStaff`, which
 * requires `membership.manage` within the organisation — a permission no Spike
 * operator has or should have. The authority for this one is
 * `requirePlatformOperator`, checked first.
 */
export async function provisionCustomer(
  tx: Sql,
  authUserId: string,
  input: {
    name: string;
    slug: string;
    legalEntityName: string;
    planKey: string;
    countryCode?: string;
    currencyCode?: string;
    timeZone?: string;
    administrator: { fullName: string; email: string };
    /** Who asked for this account, so the record says why it exists. */
    reason: string;
  },
): Promise<{
  organisationId: string;
  invitationId: string;
  /** Returned once. Stored only as a hash; nobody can recover it afterwards. */
  token: string;
  expiresAt: Date;
}> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.provision');

  const details = parsed(
    z.object({
      name: z.string().trim().min(2).max(200),
      slug: z.string().trim().regex(
        /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/,
        'Use lower-case letters, numbers and dashes — it appears in every URL.',
      ),
      legalEntityName: z.string().trim().min(2).max(200),
      planKey: z.string().trim().min(2).max(40),
      countryCode: z.string().length(2).toUpperCase().optional(),
      currencyCode: z.string().length(3).toUpperCase().optional(),
      timeZone: z.string().trim().min(3).max(60).optional(),
      administrator: z.object({
        fullName: z.string().trim().min(2).max(160),
        email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
      }),
      reason: z.string().trim().min(5, 'Say who asked for this account.').max(500),
    }),
    input,
  );

  const [plan] = await tx<{ key: string }[]>`
    select key from plans where key = ${details.planKey} and is_active
  `;
  if (!plan) throw notFound('Plan');

  const [clash] = await tx<{ slug: string }[]>`
    select slug from organisations where slug = ${details.slug}
  `;
  if (clash) {
    throw new DomainError(
      'duplicate',
      `The address "${details.slug}" is already taken. It appears in every URL this customer `
        + 'uses, so no two organisations can share one.',
    );
  }

  const { organisationId } = await createOrganisationShell(tx, {
    name: details.name,
    slug: details.slug,
    legalEntityName: details.legalEntityName,
    planKey: details.planKey,
    countryCode: details.countryCode,
    currencyCode: details.currencyCode,
    timeZone: details.timeZone,
  }, authUserId);

  // The same token shape as every other invitation in the product: 32 random
  // bytes, stored only as its sha256, returned once.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest();
  const expiresAt = new Date(Date.now() + 14 * 86_400_000);

  const [invitation] = await tx<{ id: string }[]>`
    insert into staff_invitations (
      organisation_id, invited_email, full_name, roles, scope_type,
      invite_token_hash, invited_by, expires_at
    ) values (
      ${organisationId}, ${details.administrator.email}, ${details.administrator.fullName},
      ${['org_admin']}, 'organisation', ${tokenHash}, ${authUserId},
      ${expiresAt.toISOString()}
    )
    returning id
  `;
  if (!invitation) throw new DomainError('internal', 'Invitation insert returned no row.');

  await recordAudit(tx, {
    organisationId,
    actorUserId: authUserId,
    action: 'platform.customer_provisioned',
    resourceType: 'organisation',
    resourceId: organisationId,
    reason: details.reason,
    after: {
      name: details.name,
      slug: details.slug,
      plan: details.planKey,
      administratorEmail: details.administrator.email,
      provisionedBy: operator.fullName,
      // Said plainly: Spike created the organisation and is not in it.
      spikeMembership: 'none',
      memberCount: 0,
    },
  });

  return { organisationId, invitationId: invitation.id, token, expiresAt };
}

/**
 * Customers that exist but that nobody has accepted yet.
 *
 * A provisioned organisation with no members is invisible to everybody,
 * including the operator who created it, so a forgotten one would sit there
 * unnoticed. This is the one view that can see them, and it exists so that
 * "we set them up last month and never heard back" is answerable.
 *
 * MUST be called on a transaction whose row-level filtering is lifted — the
 * rows it reads are in organisations the caller is deliberately not a member
 * of, so an ordinary request-scoped connection returns nothing at all rather
 * than erroring. The platform-operator check below still runs, because the
 * caller's identity is on the transaction either way.
 */
export async function listPendingCustomers(
  tx: Sql,
  authUserId: string,
): Promise<Array<{
  organisationId: string;
  name: string;
  slug: string;
  administratorName: string;
  administratorEmail: string;
  invitedAt: string;
  expiresAt: string;
  lapsed: boolean;
}>> {
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');

  const rows = await tx<
    { organisation_id: string; name: string; slug: string; full_name: string;
      invited_email: string; invited_at: string; expires_at: string; lapsed: boolean }[]
  >`
    select o.id as organisation_id, o.name, o.slug, i.full_name,
           i.invited_email::text as invited_email, i.invited_at::text, i.expires_at::text,
           (i.expires_at < now()) as lapsed
      from staff_invitations i
      join organisations o on o.id = i.organisation_id
     where i.status = 'invited'
       and not exists (
         select 1 from memberships m where m.organisation_id = o.id
       )
     order by i.invited_at desc
     limit 200
  `;
  return rows.map((r) => ({
    organisationId: r.organisation_id,
    name: r.name,
    slug: r.slug,
    administratorName: r.full_name,
    administratorEmail: r.invited_email,
    invitedAt: r.invited_at,
    expiresAt: r.expires_at,
    lapsed: r.lapsed,
  }));
}
