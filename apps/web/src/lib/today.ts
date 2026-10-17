/**
 * Today, where the customer is.
 *
 * `new Date()` in a server component is the server's date in UTC, and in a
 * client component it is the browser's date in whatever zone the device is
 * set to. Neither is "today" for a South African landlord or resident, and
 * using both in one component is a hydration mismatch waiting for the hours
 * between midnight and 02:00 SAST, when UTC is still yesterday.
 *
 * Kept in its own module, free of any other dependency, so a page, a route
 * handler and the report filters can all agree on the same answer.
 */
export function todayIn(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the storable form.
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
