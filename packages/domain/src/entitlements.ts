import type { Sql } from '@propertyos/db';
import { DomainError } from './errors';

/**
 * Plan entitlements: what a customer may ADD.
 *
 * Separate from `platform.ts` because the enforcement points are in customer
 * code — adding a unit, inviting a colleague — while the module that sells the
 * plans is Spike's. The rule everywhere here is the one from the blueprint:
 * exceeding an allowance blocks the NEXT record and never touches an existing
 * one. A commercial limit is not allowed to make a lease invisible or stop rent
 * being recorded.
 */

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
  // The allowance in force TODAY, which is a different question from the one
  // the billing run asks: it reads the price for the period it is billing.
  // What somebody may do now follows the price list now.
  const [plan] = await tx<{ included_units: number | null; limit_value: number | null }[]>`
    select (select price.included_units
              from app.plan_price_at(p.key, current_date) price) as included_units,
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
    // Members AND invitations nobody has accepted yet. This counted
    // `memberships` alone, with `status in ('active', 'invited')` — and a
    // membership row is only written when an invitation is ACCEPTED, so no
    // membership is ever 'invited' and a pending invitation counted as
    // nothing. An administrator at the cap could therefore invite as many
    // colleagues as they liked and let each one walk through it.
    //
    // An invitation that has expired or been revoked grants nobody anything,
    // so it is not counted; an outstanding one is a seat already given away.
    const [row] = await tx<{ count: string }[]>`
      select (
        (select count(*) from memberships
          where organisation_id = ${organisationId}::uuid
            and status in ('active', 'invited'))
        +
        (select count(*) from staff_invitations
          where organisation_id = ${organisationId}::uuid
            and status = 'invited'
            and expires_at > now())
      )::text as count
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
