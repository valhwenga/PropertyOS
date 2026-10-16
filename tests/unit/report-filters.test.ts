/**
 * What a report may be asked, and what it does with a question it cannot read.
 *
 * Two failures live here and neither shows up on a working page. A malformed
 * date reached PostgreSQL as `'banana'::date` and answered 500, so a mistyped
 * URL or a stale bookmark broke the page rather than showing the default. And
 * a filter a report does not honour must never be offered or recorded: the
 * exported file repeats its filters at the top, so a period written into a
 * file that ignores periods is a caption contradicting its own figures.
 */
import { describe, it, expect } from 'vitest';
import {
  monthOf, periodLabel, REPORT_SHAPES, reportQueryString, resolveReport, todayIn,
} from '../../apps/web/src/lib/report-shapes';

const PROPERTIES = new Set(['11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222']);
const [FIRST, SECOND] = [...PROPERTIES];
const TZ = 'Africa/Johannesburg';

describe('the month a report defaults to', () => {
  it('ends on the real last day, leap year included', () => {
    expect(monthOf('2026-10-16')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthOf('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthOf('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthOf('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('is today where the customer is, not where the server is', () => {
    // Johannesburg is two hours ahead of UTC, so just after midnight there the
    // UTC date is still yesterday — and at the turn of a month that is the
    // wrong month entirely.
    expect(todayIn(TZ)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayIn('Pacific/Kiritimati') >= todayIn('Pacific/Niue')).toBe(true);
  });
});

describe('resolveReport', () => {
  const run = (slug: string, query: Record<string, string | string[]>) =>
    resolveReport(REPORT_SHAPES[slug]!, query, TZ, PROPERTIES);

  it('falls back to the default period rather than failing on a bad date', () => {
    const { filters, ignored } = run('collection', { from: 'banana', to: '2026-10-31' });
    expect(filters.periodStart).toBe(monthOf(todayIn(TZ)).from);
    expect(ignored).toContain('the dates');
  });

  it('refuses a period that ends before it starts, and says so', () => {
    const { filters, ignored } = run('collection', { from: '2026-10-31', to: '2026-10-01' });
    expect(filters.periodStart).toBe(monthOf(todayIn(TZ)).from);
    expect(ignored).toContain('ends before it starts');
  });

  it('accepts a period it can read, and reports nothing ignored', () => {
    const { filters, ignored } = run('collection', { from: '2026-01-01', to: '2026-03-31' });
    expect(filters.periodStart).toBe('2026-01-01');
    expect(filters.periodEnd).toBe('2026-03-31');
    expect(ignored).toBeUndefined();
  });

  it('rejects a date that is well formed and not a date', () => {
    // 31 February parses in a Date constructor and silently becomes 3 March.
    const { ignored } = run('rent-roll', { asAt: '2026-02-31' });
    expect(ignored).toContain('the date');
  });

  it('keeps only property ids the viewer was actually offered', () => {
    const { filters, ignored } = run('expenses', {
      property: [FIRST!, '33333333-3333-3333-3333-333333333333'],
    });
    expect(filters.propertyIds).toEqual([FIRST]);
    expect(ignored).toContain('not in your scope');
  });

  it('treats no property ticked as every property', () => {
    expect(run('expenses', {}).filters.propertyIds).toBeUndefined();
  });

  it('ignores a property filter on a report that is not property-scoped', () => {
    // Journal lines deliberately cover the whole organisation: a bank receipt
    // belongs to no single property, so a property-filtered set would not
    // balance. Accepting the parameter here would produce a file whose header
    // claims a narrowing that never happened.
    expect(run('journal-lines', { property: FIRST! }).filters.propertyIds).toBeUndefined();
  });

  it('only accepts a horizon it offers', () => {
    expect(run('lease-expiry', { within: '90' }).filters.withinDays).toBe(90);
    const sneaky = run('lease-expiry', { within: '99999' });
    expect(sneaky.filters.withinDays).toBe(180);
    expect(sneaky.ignored).toContain('the horizon');
  });

  it('gives a point-in-time report no period to misreport', () => {
    const { filters } = run('arrears', { from: '2026-01-01', to: '2026-03-31' });
    // The period is still carried for the default, but the shape is what
    // decides whether it is passed to the report or shown as a control.
    expect(REPORT_SHAPES.arrears!.period).toBe('now');
    expect(filters.asAt).toBeUndefined();
  });
});

describe('what the report says it covers', () => {
  const resolved = (slug: string, query: Record<string, string> = {}) =>
    resolveReport(REPORT_SHAPES[slug]!, query, TZ, PROPERTIES);

  it('states a range in the product\'s own date format', () => {
    const r = resolved('collection', { from: '2026-01-01', to: '2026-03-31' });
    const label = periodLabel(REPORT_SHAPES.collection!, r.filters, '2026-10-16');
    expect(label.sentence).toBe('01/01/2026 to 31/03/2026');
    // The file name sorts, so it keeps the ISO form.
    expect(label.fileSuffix).toBe('2026-01-01-to-2026-03-31');
  });

  it('never files a point-in-time report under a month range', () => {
    const r = resolved('rent-roll', { asAt: '2026-06-30' });
    const label = periodLabel(REPORT_SHAPES['rent-roll']!, r.filters, '2026-10-16');
    expect(label.sentence).toBe('as at 30/06/2026');
    expect(label.fileSuffix).toBe('as-at-2026-06-30');
  });

  it('says a horizon is a horizon', () => {
    const r = resolved('lease-expiry', { within: '30' });
    const label = periodLabel(REPORT_SHAPES['lease-expiry']!, r.filters, '2026-10-16');
    expect(label.sentence).toContain('within 30 days of 16/10/2026');
  });

  it('reproduces itself in a query string, and only what applies', () => {
    const r = resolved('rent-roll', { asAt: '2026-06-30' });
    r.filters.propertyIds = [FIRST!, SECOND!];
    const qs = reportQueryString(REPORT_SHAPES['rent-roll']!, r.filters);
    expect(qs).toContain('asAt=2026-06-30');
    expect(qs).not.toContain('from=');
    expect(qs.match(/property=/g)).toHaveLength(2);
  });
});
