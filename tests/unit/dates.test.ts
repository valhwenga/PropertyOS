import { describe, expect, it } from 'vitest';
import {
  formatDayMonthYear, formatDayMonthYearTime, isStorableDate, parseDayMonthYear,
} from '../../packages/domain/src/dates';

describe('dates are written one way', () => {
  it('renders ISO as dd/mm/yyyy', () => {
    expect(formatDayMonthYear('2026-10-06')).toBe('06/10/2026');
    expect(formatDayMonthYear('2025-11-01')).toBe('01/11/2025');
    expect(formatDayMonthYear('2026-12-31')).toBe('31/12/2026');
  });

  it('takes the date part of a timestamp without shifting it across midnight', () => {
    // 23:30 UTC is the next day in Johannesburg; the DATE shown must still be
    // the one stored, not one a time zone moved.
    expect(formatDayMonthYear('2026-10-06T23:30:00Z')).toBe('06/10/2026');
    expect(formatDayMonthYear('2026-10-06T00:15:00Z')).toBe('06/10/2026');
  });

  it('is empty rather than wrong for anything unusable', () => {
    expect(formatDayMonthYear(null)).toBe('');
    expect(formatDayMonthYear(undefined)).toBe('');
    expect(formatDayMonthYear('')).toBe('');
    expect(formatDayMonthYear('not a date')).toBe('');
    expect(formatDayMonthYear(new Date('nonsense'))).toBe('');
  });

  it('parses what a person types back to the stored form', () => {
    expect(parseDayMonthYear('06/10/2026')).toBe('2026-10-06');
    expect(parseDayMonthYear('6/10/2026')).toBe('2026-10-06');
    expect(parseDayMonthYear('06-10-2026')).toBe('2026-10-06');
    expect(parseDayMonthYear('06.10.2026')).toBe('2026-10-06');
    expect(parseDayMonthYear('  06/10/2026 ')).toBe('2026-10-06');
  });

  // The whole point of the convention: this is October, never June.
  it('reads the first number as the day', () => {
    expect(parseDayMonthYear('06/10/2026')).toBe('2026-10-06');
    expect(parseDayMonthYear('10/06/2026')).toBe('2026-06-10');
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(parseDayMonthYear('31/02/2026')).toBeNull();
    expect(parseDayMonthYear('32/01/2026')).toBeNull();
    expect(parseDayMonthYear('01/13/2026')).toBeNull();
    expect(parseDayMonthYear('00/01/2026')).toBeNull();
    expect(parseDayMonthYear('2026-10-06')).toBeNull();
    expect(parseDayMonthYear('')).toBeNull();
    expect(parseDayMonthYear(null)).toBeNull();
  });

  it('knows which Februaries have 29 days', () => {
    expect(parseDayMonthYear('29/02/2024')).toBe('2024-02-29');
    expect(parseDayMonthYear('29/02/2000')).toBe('2000-02-29');
    expect(parseDayMonthYear('29/02/2026')).toBeNull();
    expect(parseDayMonthYear('29/02/1900')).toBeNull();
  });

  it('round-trips every date it accepts', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-06-10', '2026-12-31']) {
      expect(parseDayMonthYear(formatDayMonthYear(iso))).toBe(iso);
      expect(isStorableDate(iso)).toBe(true);
    }
  });

  it('renders a timestamp in the organisation time zone', () => {
    // 22:30 UTC is 00:30 the next day in Johannesburg.
    expect(formatDayMonthYearTime('2026-10-06T22:30:00Z')).toBe('07/10/2026 00:30');
    expect(formatDayMonthYearTime('2026-10-06T10:00:00Z')).toBe('06/10/2026 12:00');
    expect(formatDayMonthYearTime(null)).toBe('');
  });
});
