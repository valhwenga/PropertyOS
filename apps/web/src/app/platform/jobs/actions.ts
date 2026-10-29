'use server';

import { revalidatePath } from 'next/cache';
import {
  abandonJob, liftSuppression, retryDeadJobsOfType, retryJob,
} from '@propertyos/domain';
import { command } from '@/lib/actions';

/**
 * Deciding whether failed work runs.
 *
 * Not privileged: `jobs` gained platform policies keyed on
 * `platform.operations.manage` in migration 0079, so the operator's own
 * context is enough and the permission is resolved in SQL.
 *
 * Nothing here edits a payload. The handler was queued by the customer's own
 * action and does what it was always going to do; the only decision available
 * is whether it runs.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function retryJobAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    retryJob(tx, viewer.authUserId, {
      jobId: str(formData, 'jobId'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/jobs');
  return result;
}

export async function abandonJobAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    abandonJob(tx, viewer.authUserId, {
      jobId: str(formData, 'jobId'),
      reason: str(formData, 'reason'),
    }).then(() => ({})),
  );
  if (result.ok) revalidatePath('/platform/jobs');
  return result;
}

export async function retryTypeAction(_previous: unknown, formData: FormData) {
  const result = await command(async ({ tx, viewer }) => {
    const { retried } = await retryDeadJobsOfType(tx, viewer.authUserId, {
      jobType: str(formData, 'jobType'),
      reason: str(formData, 'reason'),
    });
    return { retried };
  });
  if (result.ok) revalidatePath('/platform/jobs');
  return result;
}

/**
 * Trying a dead address again.
 *
 * Privileged: `email_suppressions` has no update policy for the application
 * role at all, because an address coming off the list means mail starts
 * flowing to it again and that is not something a web request should be able
 * to do under its own authority. The permission is checked in SQL inside the
 * domain function, against the caller's own identity.
 */
export async function liftSuppressionAction(_previous: unknown, formData: FormData) {
  const result = await command(({ tx, viewer }) =>
    liftSuppression(tx, viewer.authUserId, {
      suppressionId: str(formData, 'suppressionId'),
      reason: str(formData, 'reason'),
    }).then(() => ({})), { privileged: true });
  if (result.ok) revalidatePath('/platform/jobs');
  return result;
}
