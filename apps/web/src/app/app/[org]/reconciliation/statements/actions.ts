'use server';

import { revalidatePath } from 'next/cache';
import {
  getBankLine, ignoreBankLine, importStatement, previewStatementImport, reopenBankLine,
  suggestPayers, type PayerCandidate, type StatementPreview,
} from '@propertyos/domain';
import { command } from '@/lib/actions';
import { requireOperator } from '@/lib/auth';

/**
 * Bank statement import.
 *
 * The preview is recomputed on the server on both calls. The browser never
 * tells the server which rows are new: a client that could say so could import
 * a duplicate by saying it.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

/**
 * Reads the file the operator chose and reports what an import would do.
 *
 * Writes nothing. The file is read here rather than uploaded anywhere: a
 * statement is not a document the product stores, and keeping a copy of
 * somebody's whole bank statement is not something to do by accident.
 */
export async function previewStatementAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const file = formData.get('statement');
  const bankAccountId = str(formData, 'bankAccountId');

  const csv = file instanceof File && file.size > 0
    ? await file.text()
    : str(formData, 'pasted');

  const result = await command(async ({ tx }) => {
    const context = await requireOperator(org);
    const preview = await previewStatementImport(tx, context.organisationId, {
      bankAccountId, csv,
    });
    return {
      preview: serialise(preview),
      filename: file instanceof File && file.name ? file.name : 'pasted-statement.csv',
      csv,
    };
  });
  return result;
}

export async function importStatementAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const file = formData.get('statement');
  const csv = file instanceof File && file.size > 0
    ? await file.text()
    : str(formData, 'pasted');

  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    return importStatement(tx, context.organisationId, viewer.authUserId, {
      bankAccountId: str(formData, 'bankAccountId'),
      csv,
      filename: str(formData, 'filename') || 'statement.csv',
    });
  });

  if (result.ok) {
    revalidatePath(`/app/${org}/reconciliation/statements`);
    revalidatePath(`/app/${org}/reconciliation`);
  }
  return result;
}

export async function ignoreLineAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await ignoreBankLine(tx, context.organisationId, viewer.authUserId, {
      bankTransactionId: str(formData, 'bankTransactionId'),
      reason: str(formData, 'reason'),
    });
    return { setAside: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/reconciliation/statements`);
  return result;
}

export async function reopenLineAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const result = await command(async ({ tx, viewer }) => {
    const context = await requireOperator(org);
    await reopenBankLine(tx, context.organisationId, viewer.authUserId, {
      bankTransactionId: str(formData, 'bankTransactionId'),
    });
    return { reopened: true };
  });
  if (result.ok) revalidatePath(`/app/${org}/reconciliation/statements`);
  return result;
}

/**
 * Who this line might be from, with the reason in words.
 *
 * A suggestion the operator reads and decides on. Nothing is applied, and a
 * single candidate is not treated as an answer.
 */
export async function suggestPayersAction(_previous: unknown, formData: FormData) {
  const org = str(formData, 'org');
  const bankTransactionId = str(formData, 'bankTransactionId');
  return command(async ({ tx }) => {
    const context = await requireOperator(org);
    const line = await getBankLine(tx, context.organisationId, bankTransactionId);
    const candidates = await suggestPayers(tx, context.organisationId, { bankTransactionId });
    return {
      candidates: candidates.map((c: PayerCandidate) => ({
        ...c, outstandingMinor: c.outstandingMinor.toString(),
      })),
      line: line
        ? {
            id: line.id, transactionDate: line.transactionDate, description: line.description,
            amountMinor: line.amountMinor.toString(),
          }
        : null,
    };
  });
}

/** bigints do not cross the server boundary; minor units become strings. */
function serialise(preview: StatementPreview) {
  return {
    ...preview,
    creditsMinor: preview.creditsMinor.toString(),
    debitsMinor: preview.debitsMinor.toString(),
    rows: preview.rows.map((r) => ({
      ...r,
      amountMinor: r.amountMinor === undefined ? undefined : r.amountMinor.toString(),
    })),
  };
}
