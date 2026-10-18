/**
 * Splits a fixture prefix off an organisation's name.
 *
 * Demo and load-test organisations are named "[DEMO] Blue Crane Rentals" so
 * that synthetic data can never be mistaken for a customer's. That matters, and
 * repeating it in the sidebar, in every page header and in every breadcrumb did
 * not make it matter more — it just left a bracketed shout on every screen. The
 * label becomes one small badge; the name reads as a name.
 *
 * Its own module because both a server component (the shell) and a client one
 * (the organisation switcher) need it, and neither should drag the other in.
 */
export function splitEnvironmentLabel(name: string): { label: string | null; name: string } {
  const match = /^\[([A-Z]{3,8})\]\s*(.+)$/.exec(name);
  return match ? { label: match[1]!, name: match[2]! } : { label: null, name };
}
