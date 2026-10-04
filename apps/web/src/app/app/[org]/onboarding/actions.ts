'use server';

import { revalidatePath } from 'next/cache';
import { commitImport, previewImport, type ImportKind, type ImportPreview } from '@propertyos/domain';
import { DomainError } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

const MAX_BYTES = 5 * 1024 * 1024;

async function readCsv(formData: FormData): Promise<{ filename: string; content: string }> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new DomainError('validation_failed', 'Choose a CSV file to upload.');
  }
  if (file.size > MAX_BYTES) {
    throw new DomainError('validation_failed', 'That file is larger than 5 MB. Split it into smaller batches.');
  }
  return { filename: file.name, content: await file.text() };
}

export async function previewImportAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const kind = String(formData.get('kind')) as ImportKind;

  return command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    const { filename, content } = await readCsv(formData);
    const preview: ImportPreview = await previewImport(tx, context.organisationId, {
      kind, filename, content,
    });
    void viewer;
    // The file content is echoed back so the commit step does not require a
    // second upload. It never leaves this user's own session.
    return { preview, content };
  });
}

export async function commitImportAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const kind = String(formData.get('kind')) as ImportKind;
  const filename = String(formData.get('filename'));
  const content = String(formData.get('content'));
  const cutOffDate = String(formData.get('cutOffDate') ?? '').trim() || undefined;
  const sourceReference = String(formData.get('sourceReference') ?? '').trim() || undefined;
  const confirmApproval = formData.get('confirmApproval') === 'on';

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);

    // The approver is the signed-in user, and only when they explicitly tick the
    // confirmation. We never infer approval from the fact that someone uploaded
    // a file.
    const approvedByUserId =
      kind === 'opening_balances' && confirmApproval ? viewer.authUserId : undefined;

    if (kind === 'opening_balances' && !confirmApproval) {
      throw new DomainError(
        'validation_failed',
        'Confirm that you have checked these opening balances against your records before importing them.',
      );
    }

    return commitImport(tx, context.organisationId, viewer.authUserId, {
      kind, filename, content, cutOffDate, sourceReference, approvedByUserId,
    });
  });

  if (result.ok) revalidatePath(`/app/${org}/onboarding`);
  return result;
}
