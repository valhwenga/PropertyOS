'use server';

import { revalidatePath } from 'next/cache';
import {
  changePlan, closeSupportSession, openSupportSession, setAccountStatus,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * The four things a Spike operator can do to a customer account.
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

const ACCOUNT_STATUSES = new Set(['trial', 'active', 'suspended', 'closed']);

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
