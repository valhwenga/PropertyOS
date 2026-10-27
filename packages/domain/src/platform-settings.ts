import { z } from 'zod';
import type { Sql } from '@propertyos/db';
import { conflict, invalid, notFound, parsed } from './errors';
import { recordAudit } from './audit';
import { requirePlatformOperator, requirePlatformPermission } from './platform';

/**
 * Settings, and the flags that are settings.
 *
 * Things the product decides were spread between environment variables, SQL
 * constants and numbers typed into `if` statements: a support session lasted
 * "between 1 and 24 hours" because 24 was written in `openSupportSession`, and
 * a customer who wanted their resident portal switched off could not have it.
 *
 * One mechanism, not two. A feature flag is a setting whose type is boolean;
 * the only thing distinguishing it from the hour limit is whether a single
 * customer may have a different answer. Every setting is declared in a
 * migration because code reads it — a flag the console could invent would be a
 * flag nothing reads, and somebody turning it off and seeing no change cannot
 * tell a broken feature from a fictional one.
 *
 * See docs/decisions/0025-settings-and-flags.md.
 */

export interface PlatformSetting {
  key: string;
  name: string;
  description: string;
  valueType: 'boolean' | 'integer';
  /** What the product ships with, and what deleting a value returns it to. */
  defaultValue: string;
  /** Spike's answer for everybody, where they have given one. */
  globalValue: string | null;
  globalReason: string | null;
  globalSetByName: string | null;
  /** The value in force where no customer overrides it. */
  effectiveValue: string;
  minValue: number | null;
  maxValue: number | null;
  perOrganisation: boolean;
  customerVisible: boolean;
  /** How many customers have been given a different answer. */
  overrides: number;
}

export async function platformSettings(
  tx: Sql,
  authUserId: string,
): Promise<PlatformSetting[]> {
  // Readable by anybody in the console: an operator who cannot see that the
  // resident portal is switched off for a customer cannot answer the ticket
  // about it.
  await requirePlatformOperator(tx, authUserId);

  const rows = await tx<Array<{
    key: string; name: string; description: string; value_type: 'boolean' | 'integer';
    default_value: string; global_value: string | null; global_reason: string | null;
    global_set_by_name: string | null; min_value: number | null; max_value: number | null;
    per_organisation: boolean; customer_visible: boolean; overrides: string;
  }>>`
    select s.key, s.name, s.description, s.value_type, s.default_value,
           v.value as global_value, v.reason as global_reason,
           by.full_name as global_set_by_name,
           s.min_value, s.max_value, s.per_organisation, s.customer_visible,
           (select count(*) from organisation_setting_values o where o.key = s.key)::text
             as overrides
      from platform_settings s
      left join platform_setting_values v on v.key = s.key
      left join user_profiles by on by.auth_user_id = v.set_by
     order by s.sort, s.key
  `;

  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    valueType: r.value_type,
    defaultValue: r.default_value,
    globalValue: r.global_value,
    globalReason: r.global_reason,
    globalSetByName: r.global_set_by_name,
    effectiveValue: r.global_value ?? r.default_value,
    minValue: r.min_value,
    maxValue: r.max_value,
    perOrganisation: r.per_organisation,
    customerVisible: r.customer_visible,
    overrides: Number(r.overrides),
  }));
}

export interface OrganisationSetting {
  key: string;
  name: string;
  description: string;
  valueType: 'boolean' | 'integer';
  /** What this customer gets, after their own value, Spike's, and the default. */
  effectiveValue: string;
  /** Set only where this customer has an answer of their own. */
  ownValue: string | null;
  ownReason: string | null;
  setByName: string | null;
  customerVisible: boolean;
}

/**
 * What one customer's settings resolve to, and which are theirs.
 *
 * Readable by the customer's own members as well as by Spike, filtered to the
 * ones marked customer-visible when they ask: a feature switched off for
 * somebody who cannot see that it is switched off is indistinguishable from a
 * product that is broken.
 */
export async function organisationSettings(
  tx: Sql,
  organisationId: string,
  options: { visibleToCustomerOnly?: boolean } = {},
): Promise<OrganisationSetting[]> {
  const rows = await tx<Array<{
    key: string; name: string; description: string; value_type: 'boolean' | 'integer';
    effective_value: string; own_value: string | null; own_reason: string | null;
    set_by_name: string | null; customer_visible: boolean;
  }>>`
    select s.key, s.name, s.description, s.value_type, s.customer_visible,
           app.setting(${organisationId}::uuid, s.key) as effective_value,
           o.value as own_value, o.reason as own_reason,
           by.full_name as set_by_name
      from platform_settings s
      left join organisation_setting_values o
        on o.key = s.key and o.organisation_id = ${organisationId}::uuid
      left join user_profiles by on by.auth_user_id = o.set_by
     where s.per_organisation
       and ${options.visibleToCustomerOnly ? tx`s.customer_visible` : tx`true`}
     order by s.sort, s.key
  `;
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    valueType: r.value_type,
    effectiveValue: r.effective_value,
    ownValue: r.own_value,
    ownReason: r.own_reason,
    setByName: r.set_by_name,
    customerVisible: r.customer_visible,
  }));
}

const valueSchema = z.object({
  key: z.string().trim().min(2).max(60),
  value: z.string().trim().min(1).max(40),
  reason: z.string().trim()
    .min(5, 'Say why, so the next person reading this knows.').max(500),
});

async function settingOrFail(tx: Sql, key: string) {
  const [setting] = await tx<Array<{
    key: string; name: string; value_type: string; per_organisation: boolean;
    default_value: string;
  }>>`
    select key, name, value_type, per_organisation, default_value
      from platform_settings where key = ${key}
  `;
  if (!setting) throw notFound('Setting');
  return setting;
}

/** Spike's answer for every customer who has not been given their own. */
export async function setPlatformSetting(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof valueSchema>,
): Promise<void> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.config.manage');
  const details = parsed(valueSchema, input);
  const setting = await settingOrFail(tx, details.key);

  const [before] = await tx<{ value: string }[]>`
    select value from platform_setting_values where key = ${details.key}
  `;

  // The trigger validates the type and the bounds and reports them in words;
  // this only has to carry the reason and the attribution.
  await tx`
    insert into platform_setting_values (key, value, reason, set_by)
    values (${details.key}, ${details.value}, ${details.reason}, ${authUserId}::uuid)
    on conflict (key) do update
      set value = excluded.value, reason = excluded.reason,
          set_by = excluded.set_by, set_at = now()
  `;

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.setting_changed',
    resourceType: 'platform_setting',
    resourceId: null,
    reason: details.reason,
    before: { setting: setting.key, value: before?.value ?? setting.default_value },
    after: { setting: setting.key, value: details.value, changedBy: actor.fullName },
  });
}

/** Returns a setting to what the product ships with. */
export async function clearPlatformSetting(
  tx: Sql,
  authUserId: string,
  input: { key: string; reason: string },
): Promise<void> {
  await requirePlatformPermission(tx, authUserId, 'platform.config.manage');
  const details = parsed(valueSchema.omit({ value: true }), input);
  const setting = await settingOrFail(tx, details.key);

  const removed = await tx<{ value: string }[]>`
    delete from platform_setting_values where key = ${details.key} returning value
  `;
  if (removed.length === 0) {
    throw conflict('That setting is already at its default. Nothing was changed.');
  }

  await recordAudit(tx, {
    organisationId: null,
    actorUserId: authUserId,
    action: 'platform.setting_cleared',
    resourceType: 'platform_setting',
    resourceId: null,
    reason: details.reason,
    before: { setting: setting.key, value: removed[0]!.value },
    after: { setting: setting.key, value: setting.default_value, source: 'default' },
  });
}

/**
 * One customer's own answer.
 *
 * Audited against THEM rather than against no organisation: switching off a
 * customer's resident portal is a thing that happened to that customer, and
 * belongs in the trail somebody reviewing them would read.
 */
export async function setOrganisationSetting(
  tx: Sql,
  authUserId: string,
  input: z.input<typeof valueSchema> & { organisationId: string },
): Promise<void> {
  const actor = await requirePlatformPermission(tx, authUserId, 'platform.config.manage');
  const details = parsed(
    valueSchema.extend({ organisationId: z.string().uuid() }),
    input,
  );
  const setting = await settingOrFail(tx, details.key);
  if (!setting.per_organisation) {
    throw invalid(`"${setting.name}" is the same for every customer and cannot be set for one.`);
  }

  const [organisation] = await tx<{ name: string }[]>`
    select name from organisations where id = ${details.organisationId}::uuid
  `;
  if (!organisation) throw notFound('Customer');

  const [before] = await tx<{ effective: string }[]>`
    select app.setting(${details.organisationId}::uuid, ${details.key}) as effective
  `;

  await tx`
    insert into organisation_setting_values (
      organisation_id, key, value, reason, set_by
    ) values (
      ${details.organisationId}::uuid, ${details.key}, ${details.value},
      ${details.reason}, ${authUserId}::uuid
    )
    on conflict (organisation_id, key) do update
      set value = excluded.value, reason = excluded.reason,
          set_by = excluded.set_by, set_at = now()
  `;

  await recordAudit(tx, {
    organisationId: details.organisationId,
    actorUserId: authUserId,
    action: 'platform.customer_setting_changed',
    resourceType: 'platform_setting',
    resourceId: null,
    reason: details.reason,
    before: { setting: setting.key, value: before?.effective ?? setting.default_value },
    after: { setting: setting.key, value: details.value, changedBy: actor.fullName },
  });
}

/** Returns one customer to whatever everybody else gets. */
export async function clearOrganisationSetting(
  tx: Sql,
  authUserId: string,
  input: { organisationId: string; key: string; reason: string },
): Promise<void> {
  await requirePlatformPermission(tx, authUserId, 'platform.config.manage');
  const details = parsed(
    valueSchema.omit({ value: true }).extend({ organisationId: z.string().uuid() }),
    input,
  );
  const setting = await settingOrFail(tx, details.key);

  const removed = await tx<{ value: string }[]>`
    delete from organisation_setting_values
     where organisation_id = ${details.organisationId}::uuid and key = ${details.key}
     returning value
  `;
  if (removed.length === 0) {
    throw conflict('That customer has no answer of their own for this. Nothing was changed.');
  }

  await recordAudit(tx, {
    organisationId: details.organisationId,
    actorUserId: authUserId,
    action: 'platform.customer_setting_cleared',
    resourceType: 'platform_setting',
    resourceId: null,
    reason: details.reason,
    before: { setting: setting.key, value: removed[0]!.value },
    after: { setting: setting.key, source: 'whatever every other customer gets' },
  });
}
