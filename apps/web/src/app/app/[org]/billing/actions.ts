'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { postBillingRun, previewBillingRun, saveBillingPreview } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Billing run commands.
 *
 * Two separate acts, with separate permissions, because the blueprint's
 * finance separation turns on exactly this distinction. Preparing a run
 * (`billing.preview`) writes no charge and no journal: it records what the
 * period WOULD raise and which leases it refuses to touch. Posting
 * (`billing.post`) is the financial write. A finance preparer can do the first
 * and not the second; for a small landlord the same person holds both, which
 * §4 explicitly allows for ordinary billing.
 *
 * Everything that makes posting safe — the preview-version guard, the
 * recomputation from live data, the per-schedule duplicate key and the
 * idempotent replay — is in the domain and is not restated here.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

/**
 * Records a reviewed preview as a run.
 *
 * The run is saved as `validated` only when nothing blocking is outstanding;
 * otherwise it stays `preview` and cannot be posted. That decision is the
 * domain's, from the exceptions it found, not this form's.
 */
export async function prepareBillingRunAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const periodStart = str(formData, 'periodStart');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    // Recomputed here rather than trusting figures that travelled through the
    // browser. A preview posted back from a form is a preview an attacker can
    // edit.
    const preview = await previewBillingRun(tx, context.organisationId, { periodStart });
    const saved = await saveBillingPreview(tx, context.organisationId, viewer.authUserId, preview);
    return {
      runId: saved.runId,
      previewVersion: saved.previewVersion,
      blocking: preview.exceptions.filter((e) => e.severity === 'blocking').length,
      lineCount: preview.billableLineCount,
      totalMinor: preview.totalMinor.toString(),
    };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/billing`);
    redirect(`/app/${org}/billing/${result.runId}`);
  }
  return result;
}

/**
 * Posts a prepared run.
 *
 * The idempotency key is derived from the run and the exact preview version
 * being approved, so a double-click, a retried request or a refreshed tab all
 * carry the same key. Generating a fresh one per submission would defeat the
 * purpose: a key that changes every time is not an idempotency key.
 */
export async function postBillingRunAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const runId = str(formData, 'runId');
  const previewVersion = Number(str(formData, 'previewVersion'));

  const result = await command(async ({ tx, viewer, correlationId }) => {
    const context = await requireOperator(org);
    const posted = await postBillingRun(tx, context.organisationId, viewer.authUserId, {
      runId,
      previewVersion,
      idempotencyKey: `billing-run:${runId}:v${previewVersion}`,
      issueDate: str(formData, 'issueDate'),
      correlationId,
    });
    return {
      postedCount: posted.postedCount,
      skippedCount: posted.skippedCount,
      totalMinor: posted.totalMinor.toString(),
    };
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/billing/${runId}`);
    revalidatePath(`/app/${org}/billing`);
  }
  return result;
}
