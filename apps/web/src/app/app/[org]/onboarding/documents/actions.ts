'use server';

import { revalidatePath } from 'next/cache';
import { invalid, matchDocumentsToLeases } from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';
import { storeUpload } from '@/lib/uploads';

/**
 * Bringing existing documents across, several at a time.
 *
 * Capped at ten files per batch, and the cap is not arbitrary: every upload in
 * this product arrives through a Server Action, Next buffers the whole action
 * body before any of our code runs, and the limit is set a little past the
 * largest single file the product accepts. Ten files is comfortably inside it;
 * forty would hit a wall with a message from the framework rather than from us.
 * The screen says ten rather than letting somebody find out.
 */
const MAX_FILES = 10;

export async function importDocumentsAction(_previous: unknown, formData: FormData) {
  const org = String(formData.get('org'));
  const classification = String(formData.get('classification') ?? 'lease');

  const result = await command(async ({ tx, viewer, correlationId }) => {
    const context = await requireOperator(org);

    const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) throw invalid('Choose the files to bring across.');
    if (files.length > MAX_FILES) {
      throw invalid(
        `Bring across at most ${MAX_FILES} files at a time. More than that and the upload is `
          + 'refused by the framework before this product sees it.',
      );
    }

    // Matched before anything is stored, so a file nobody can place is
    // reported rather than filed under nothing.
    const matches = await matchDocumentsToLeases(
      tx, context.organisationId, files.map((f) => f.name),
    );

    const stored: Array<{ filename: string; where: string }> = [];
    const skipped: Array<{ filename: string; reason: string }> = [];

    for (const file of files) {
      const match = matches.find((m) => m.filename === file.name);
      if (!match || match.unmatchedReason) {
        skipped.push({
          filename: file.name,
          reason: match?.unmatchedReason ?? 'That file could not be placed.',
        });
        continue;
      }
      try {
        await storeUpload(tx, {
          organisationId: context.organisationId,
          actorUserId: viewer.authUserId,
          file,
          classification,
          title: file.name,
          ...(match.leaseId ? { leaseId: match.leaseId } : {}),
          ...(match.propertyId ? { propertyId: match.propertyId } : {}),
          correlationId,
        });
        stored.push({
          filename: file.name,
          where: match.leaseReference ?? match.propertyCode ?? 'the organisation',
        });
      } catch (error) {
        // One unreadable file does not stop the batch: a folder of four
        // hundred contracts will contain a `.DS_Store`, and the answer is to
        // say so rather than to refuse the other nine.
        skipped.push({
          filename: file.name,
          reason: error instanceof Error ? error.message : 'That file was not accepted.',
        });
      }
    }

    return { stored, skipped };
  });

  if (result.ok) revalidatePath(`/app/${org}/documents`);
  return result;
}
