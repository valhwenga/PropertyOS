import { formatDayMonthYear, parseDayMonthYear } from '@propertyos/domain/dates';
import type { ReportFilters } from '@propertyos/domain';

/**
 * What each report may be asked, and what it was actually asked.
 *
 * One module for both because the screen and the CSV export are two
 * renderings of the same question, and they were drifting: the page read
 * `from` and `to` from the URL while the export route parsed them again on its
 * own, and several reports were called from the route with no filters at all.
 * The file is the thing a person forwards to an accountant, so a file that
 * silently covers a different scope from the screen it was downloaded from is
 * the worst version of this bug.
 *
 * The shapes are also a promise about the controls. A report that ignores a
 * date is not offered a date box: a filter that is accepted and discarded is
 * worse than one that is absent, because the figures then look like an answer
 * to a question nobody asked.
 */

export type PeriodKind =
  /** Covers a span of business dates: from and to. */
  | 'range'
  /** A position on one date, which may be in the past. */
  | 'asAt'
  /** A position as the records stand now, and not re-creatable for a past date. */
  | 'now'
  /** Looks forward a chosen number of days. */
  | 'horizon';

export interface ReportShape {
  slug: string;
  name: string;
  period: PeriodKind;
  /** Whether this report narrows to chosen properties. */
  property: boolean;
}

export const REPORT_SHAPES: Record<string, ReportShape> = {
  'rent-roll': { slug: 'rent-roll', name: 'Rent roll', period: 'asAt', property: true },
  // The ageing view is computed against the records as they stand. Offering an
  // "as at" box here would accept a date and quietly ignore it.
  arrears: { slug: 'arrears', name: 'Arrears ageing', period: 'now', property: true },
  collection: { slug: 'collection', name: 'Collection report', period: 'range', property: true },
  expenses: { slug: 'expenses', name: 'Expense report', period: 'range', property: true },
  deposits: { slug: 'deposits', name: 'Deposit register', period: 'now', property: true },
  'lease-expiry': { slug: 'lease-expiry', name: 'Lease expiry', period: 'horizon', property: true },
  occupancy: { slug: 'occupancy', name: 'Occupancy', period: 'range', property: true },
  // Deliberately not property-filtered; the report says why on its face.
  'journal-lines': { slug: 'journal-lines', name: 'Journal lines', period: 'range', property: false },
};

/** The horizons offered for lease expiry, in days. */
export const HORIZONS = [30, 60, 90, 180, 365] as const;
const DEFAULT_HORIZON = 180;

/** Today where the customer is, not where the server is. */
export function todayIn(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the storable form.
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** The calendar month containing `today`. */
export function monthOf(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0));
  return { from: `${today.slice(0, 7)}-01`, to: end.toISOString().slice(0, 10) };
}

/**
 * Reads a date from the query string, or returns null.
 *
 * ISO because that is what the date controls submit and what makes a shared
 * link unambiguous; dd/mm/yyyy as well because that is how this product writes
 * every other date, and somebody editing the address bar will type it.
 *
 * The round-trip check matters: `new Date('2026-02-31')` is a valid Date — it
 * is 3 March — so a date that does not exist would otherwise be accepted and
 * silently answer for a different day.
 */
function readDate(value: string | undefined): string | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : parseDayMonthYear(value);
  if (!iso) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export interface ResolvedReport {
  filters: ReportFilters & { periodStart: string; periodEnd: string; withinDays: number };
  /** Set when the query string could not be read and a default was used instead. */
  ignored?: string;
}

export interface ReportQuery {
  from?: string; to?: string; asAt?: string; within?: string; property?: string | string[];
}

/**
 * Reads the query string into filters, falling back rather than failing.
 *
 * A malformed date used to reach PostgreSQL as `'banana'::date` and answer 500,
 * which turns a mistyped URL — or a stale bookmark — into a broken page. An
 * unreadable value is replaced by the default and SAID, so nobody reads the
 * resulting figures as an answer to what they typed.
 */
export function resolveReport(
  shape: ReportShape,
  query: ReportQuery,
  timeZone: string,
  allowedPropertyIds: ReadonlySet<string>,
): ResolvedReport {
  const today = todayIn(timeZone);
  const month = monthOf(today);
  const ignored: string[] = [];

  let periodStart = month.from;
  let periodEnd = month.to;
  if (shape.period === 'range') {
    const from = readDate(query.from) ?? undefined;
    const to = readDate(query.to) ?? undefined;
    if ((query.from && !from) || (query.to && !to)) ignored.push('the dates');
    if (from && to && from > to) {
      ignored.push('a period that ends before it starts');
    } else {
      periodStart = from ?? periodStart;
      periodEnd = to ?? periodEnd;
    }
  }

  let asAt: string | undefined;
  if (shape.period === 'asAt') {
    const read = readDate(query.asAt);
    if (query.asAt && !read) ignored.push('the date');
    asAt = read ?? today;
  }

  let withinDays = DEFAULT_HORIZON;
  if (shape.period === 'horizon') {
    const requested = Number(query.within);
    if (query.within && !HORIZONS.includes(requested as (typeof HORIZONS)[number])) {
      ignored.push('the horizon');
    } else if (query.within) {
      withinDays = requested;
    }
  }

  // Property ids are checked against the ones this viewer was actually shown.
  // Not as an access control — RLS and the report's own scope already decide
  // what it can return — but so a typed-in id cannot reach the query and so an
  // unreadable one is reported rather than silently narrowing the figures.
  let propertyIds: string[] | undefined;
  if (shape.property) {
    const raw = query.property === undefined
      ? [] : Array.isArray(query.property) ? query.property : [query.property];
    const kept = raw.filter((id) => allowedPropertyIds.has(id));
    if (kept.length !== raw.length) ignored.push('a property that is not in your scope');
    propertyIds = kept.length > 0 ? kept : undefined;
  }

  return {
    filters: { periodStart, periodEnd, asAt, withinDays, propertyIds },
    ignored: ignored.length > 0 ? ignored.join(' and ') : undefined,
  };
}

/** The query string that reproduces this report, for the export link. */
export function reportQueryString(
  shape: ReportShape, filters: ResolvedReport['filters'],
): string {
  const params = new URLSearchParams();
  if (shape.period === 'range') {
    params.set('from', filters.periodStart);
    params.set('to', filters.periodEnd);
  }
  if (shape.period === 'asAt' && filters.asAt) params.set('asAt', filters.asAt);
  if (shape.period === 'horizon') params.set('within', String(filters.withinDays));
  for (const id of filters.propertyIds ?? []) params.append('property', id);
  return params.toString();
}

/**
 * What the report covers, in words, for the page and the file name.
 *
 * Every report says this. A rent roll with no date on it is a rent roll
 * somebody will still be reading in March.
 */
export function periodLabel(
  shape: ReportShape, filters: ResolvedReport['filters'], today: string,
): { sentence: string; fileSuffix: string } {
  // Shown the way every other date in the product is shown, and filed the way
  // a file sorts: dd/mm/yyyy for a person, ISO for the name on disk.
  switch (shape.period) {
    case 'range':
      return {
        sentence:
          `${formatDayMonthYear(filters.periodStart)} to ${formatDayMonthYear(filters.periodEnd)}`,
        fileSuffix: `${filters.periodStart}-to-${filters.periodEnd}`,
      };
    case 'asAt':
      return {
        sentence: `as at ${formatDayMonthYear(filters.asAt ?? today)}`,
        fileSuffix: `as-at-${filters.asAt ?? today}`,
      };
    case 'horizon':
      return {
        sentence:
          `leases ending within ${filters.withinDays} days of ${formatDayMonthYear(today)}`,
        fileSuffix: `${filters.withinDays}-days-from-${today}`,
      };
    default:
      return {
        sentence: `as the records stand on ${formatDayMonthYear(today)}`,
        fileSuffix: `as-at-${today}`,
      };
  }
}
