/**
 * One way to write a date.
 *
 * Every date this product shows a person is dd/mm/yyyy. That is the convention
 * in South Africa, and mixing it with anything else in the same product is how
 * 06/10 gets read as June. ISO stays the storage and transport format — query
 * parameters, form values, cut-off dates — and never reaches a screen.
 *
 * Pure, with no dependency on the database layer, so a client component can
 * import it through the package's ./dates entry point without dragging the
 * server into the browser bundle.
 */

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** "2026-10-06" or a Date -> "06/10/2026". Empty for anything unusable. */
export function formatDayMonthYear(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return [
      String(value.getUTCDate()).padStart(2, '0'),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      value.getUTCFullYear(),
    ].join('/');
  }
  // Take the date part of an ISO string without constructing a Date, so a
  // timestamp cannot be shifted across midnight by a time zone.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return '';
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** "06/10/2026 14:30" for a timestamp. */
export function formatDayMonthYearTime(
  value: string | Date | null | undefined,
  timeZone = 'Africa/Johannesburg',
): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/**
 * "06/10/2026" -> "2026-10-06", for turning what a person typed back into the
 * value that gets stored. Returns null rather than guessing: a date nobody can
 * parse must stop a lease, not become an arbitrary one.
 */
export function parseDayMonthYear(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = /^(\d{1,2})\s*[/.\- ]\s*(\d{1,2})\s*[/.\- ]\s*(\d{4})$/.exec(input.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && !leap ? 28 : MONTH_DAYS[month - 1]!;
  if (day > limit) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True when a string is a date this product can store. */
export function isStorableDate(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return parseDayMonthYear(formatDayMonthYear(iso)) === iso.slice(0, 10);
}
