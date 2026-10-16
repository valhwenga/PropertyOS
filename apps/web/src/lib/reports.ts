import 'server-only';
import type { Sql } from '@propertyos/db';
import {
  arrearsAgeing, collectionReport, depositRegister, expenseReport,
  journalLinesExport, leaseExpiryReport, occupancyReport, rentRoll,
} from '@propertyos/domain';
import type { ResolvedReport } from './report-shapes';

/**
 * Running a report.
 *
 * The shapes, the query-string parsing and the labels live in
 * `report-shapes.ts`, which has no database and no `server-only` marker so the
 * rules about what each report may be asked can be tested on their own. This
 * file is the part that touches the data.
 */
export type ReportData =
  | ({ kind: 'rent-roll' } & Awaited<ReturnType<typeof rentRoll>>)
  | ({ kind: 'arrears' } & Awaited<ReturnType<typeof arrearsAgeing>>)
  | ({ kind: 'collection' } & Awaited<ReturnType<typeof collectionReport>>)
  | ({ kind: 'expenses' } & Awaited<ReturnType<typeof expenseReport>>)
  | ({ kind: 'deposits' } & Awaited<ReturnType<typeof depositRegister>>)
  | ({ kind: 'lease-expiry' } & Awaited<ReturnType<typeof leaseExpiryReport>>)
  | ({ kind: 'occupancy' } & Awaited<ReturnType<typeof occupancyReport>>)
  | ({ kind: 'journal-lines' } & Awaited<ReturnType<typeof journalLinesExport>>);

/**
 * Runs one report with the filters it was given.
 *
 * The single place that decides what a report slug means, so the screen and
 * the exported file cannot answer differently.
 */
export async function runReport(
  tx: Sql,
  organisationId: string,
  slug: string,
  filters: ResolvedReport['filters'],
): Promise<ReportData | null> {
  // Each report is handed ONLY the filters it honours. Every report repeats
  // its filters into the exported file, so passing a period to a report that
  // ignores periods would write a period into a file that does not respect
  // one — a caption that contradicts its own figures.
  const { periodStart, periodEnd, asAt, withinDays, propertyIds } = filters;
  const period = { periodStart, periodEnd, propertyIds };

  switch (slug) {
    case 'rent-roll':
      return { kind: 'rent-roll', ...(await rentRoll(tx, organisationId, { asAt, propertyIds })) };
    case 'arrears':
      return { kind: 'arrears', ...(await arrearsAgeing(tx, organisationId, { propertyIds })) };
    case 'collection':
      return { kind: 'collection', ...(await collectionReport(tx, organisationId, period)) };
    case 'expenses':
      return { kind: 'expenses', ...(await expenseReport(tx, organisationId, period)) };
    case 'deposits':
      return { kind: 'deposits', ...(await depositRegister(tx, organisationId, { propertyIds })) };
    case 'lease-expiry':
      return {
        kind: 'lease-expiry',
        ...(await leaseExpiryReport(tx, organisationId, { withinDays, propertyIds })),
      };
    case 'occupancy':
      return { kind: 'occupancy', ...(await occupancyReport(tx, organisationId, period)) };
    case 'journal-lines':
      // No property narrowing, deliberately: see the report's own qualification.
      return {
        kind: 'journal-lines',
        ...(await journalLinesExport(tx, organisationId, { periodStart, periodEnd })),
      };
    default:
      return null;
  }
}

