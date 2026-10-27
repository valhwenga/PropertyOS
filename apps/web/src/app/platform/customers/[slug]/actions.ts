'use server';

import { revalidatePath } from 'next/cache';
import {
  changePlan, closeCustomer, closeSupportSession, destroyCustomerData,
  grantRolePermission, openSupportSession, recordDestroyedObjects, revokeRolePermission,
  setAccountStatus, setRetention,
} from '@propertyos/domain';
import { resolveStorageAdapter } from '@propertyos/integrations';
import { log } from '@/lib/logger';
import { command } from '@/lib/actions';

/**
 * The things a Spike operator can do to a customer account.
 *
 * All four existed in `packages/domain/src/platform.ts` with no screen anywhere
 * in this application, which meant the commercial side of the product — moving
 * somebody onto a bigger plan, suspending an account that is not paying, opening
 * a bounded support session to answer a ticket — could be done only by a
 * developer with a database connection.
 *
 * None of them runs privileged. The policies they need are keyed on
 * `app.is_platform_operator()` rather than on membership, so a Spike operator
 * can already update `organisations` and `subscriptions` and insert a support
 * session under their own RLS context. Provisioning needs the privilege because
 * it brings an organisation into existence; these do not, and asking for it
 * where it is not needed is how a privilege stops being noticed.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

// Without 'closed': closing needs a retention date, which the status form has
// nowhere to put, and `setAccountStatus` refuses it for that reason. Closing
// goes through `closeCustomerAction` below.
const ACCOUNT_STATUSES = new Set(['trial', 'active', 'suspended']);

export async function changePlanAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(async ({ tx, viewer }) => {
    await changePlan(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      planKey: str(formData, 'planKey'),
      reason: str(formData, 'reason'),
    });
    return { planKey: str(formData, 'planKey') };
  });
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}

export async function setAccountStatusAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const status = str(formData, 'status');
  const result = await command(async ({ tx, viewer }) => {
    if (!ACCOUNT_STATUSES.has(status)) {
      // Not a user-facing case: the form offers four options. Checked because
      // the domain function's type would otherwise be satisfied by a string
      // that arrives from a request body.
      throw new Error(`Unknown account status: ${status}`);
    }
    await setAccountStatus(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      status: status as 'trial' | 'active' | 'suspended' | 'closed',
      reason: str(formData, 'reason'),
    });
    return { status };
  });
  if (result.ok) {
    revalidatePath(`/platform/customers/${slug}`);
    revalidatePath('/platform');
  }
  return result;
}

export async function openSupportSessionAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(async ({ tx, viewer }) => {
    const session = await openSupportSession(tx, viewer.authUserId, {
      // What the operator says they need. Honoured only against a window the
      // customer already opened carrying it, and narrowed to that window —
      // otherwise the session reads and nothing more until they approve it.
      scopes: formData.getAll('scopes').map((scope) => String(scope)),
      organisationId: str(formData, 'organisationId'),
      reason: str(formData, 'reason'),
      hours: Number(str(formData, 'hours') || '1'),
    });
    return { expiresAt: session.expiresAt.toISOString() };
  });
  if (result.ok) {
    revalidatePath(`/platform/customers/${slug}`);
    revalidatePath('/platform');
  }
  return result;
}

export async function closeSupportSessionAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(({ tx, viewer }) =>
    closeSupportSession(tx, viewer.authUserId, {
      supportSessionId: str(formData, 'supportSessionId'),
    }).then(() => ({})),
  );
  if (result.ok) {
    revalidatePath(`/platform/customers/${slug}`);
    revalidatePath('/platform');
  }
  return result;
}

/**
 * Giving one customer's role one extra permission, and taking it back.
 *
 * Not privileged either: `organisation_role_permissions` is written under a
 * policy keyed on `platform.permissions.manage`, so the operator's own RLS
 * context is enough and the permission is resolved in SQL. Grants only — the
 * domain has no way to remove a permission a role carries in the catalogue, so
 * nothing here can narrow what a customer's staff may do.
 */
export async function grantRolePermissionAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(({ tx, viewer }) =>
    grantRolePermission(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      roleKey: str(formData, 'roleKey'),
      permissionKey: str(formData, 'permissionKey'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}

export async function revokeRolePermissionAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(({ tx, viewer }) =>
    revokeRolePermission(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      roleKey: str(formData, 'roleKey'),
      permissionKey: str(formData, 'permissionKey'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}

/**
 * Closing an account, and what follows from it.
 *
 * Three actions in a deliberate order: close with a date, move the date if the
 * customer asks for their records sooner, destroy once the date has passed.
 * Only the first is available to anybody but an administrator.
 */
export async function closeCustomerAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const months = Number(str(formData, 'retainMonths'));
  const result = await command(async ({ tx, viewer }) => {
    const { retainUntil } = await closeCustomer(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      reason: str(formData, 'reason'),
      ...(Number.isFinite(months) && str(formData, 'retainMonths') !== ''
        ? { retainMonths: months }
        : {}),
    });
    return { retainUntil };
  });
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}

export async function setRetentionAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const result = await command(({ tx, viewer }) =>
    setRetention(tx, viewer.authUserId, {
      organisationId: str(formData, 'organisationId'),
      retainUntil: str(formData, 'retainUntil'),
      reason: str(formData, 'reason'),
    }).then(() => ({})));
  if (result.ok) revalidatePath(`/platform/customers/${slug}`);
  return result;
}

/**
 * The one irreversible action in this console.
 *
 * The typed identifier is not security — the caller already holds
 * `platform.customers.destroy` — it is there so that destroying the wrong
 * customer's records takes more than clicking a button on the wrong row.
 *
 * Two steps, and the order is the whole point. The rows go first and commit;
 * only then are the stored files removed, because a bucket has no rollback and
 * a transaction that failed after deleting objects would leave rows pointing at
 * files that are not there. The domain function hands back the keys it read
 * before the purge, since deleting `documents` deletes the only record of where
 * those files are.
 *
 * A file that will not delete does not fail the destruction — the records are
 * already gone, and failing here would only hide that. Its key is written to
 * the closure instead, so somebody can finish the job rather than leaving a
 * document in a bucket with nothing left to find it by.
 */
export async function destroyCustomerDataAction(_previous: unknown, formData: FormData) {
  const slug = str(formData, 'slug');
  const organisationId = str(formData, 'organisationId');

  const result = await command(async ({ tx, viewer }) => {
    const { rowsDestroyed, objects } = await destroyCustomerData(tx, viewer.authUserId, {
      organisationId,
      confirmSlug: str(formData, 'confirmSlug'),
      reason: str(formData, 'reason'),
    });
    return { rowsDestroyed, objects };
  });

  if (!result.ok) return result;

  const objects = (result as { objects?: Array<{ key: string }> }).objects ?? [];
  const storage = resolveStorageAdapter();
  const left: string[] = [];
  let removed = 0;
  for (const object of objects) {
    try {
      await storage.remove(object.key);
      removed += 1;
    } catch (error) {
      left.push(object.key);
      log('error', 'destroyed customer file could not be removed', {
        organisationId,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  const recorded = await command(({ tx, viewer }) =>
    recordDestroyedObjects(tx, viewer.authUserId, { organisationId, removed, left })
      .then(() => ({})));
  if (!recorded.ok) {
    log('error', 'destroyed customer files could not be recorded', { organisationId, removed });
  }

  revalidatePath(`/platform/customers/${slug}`);
  return result;
}
