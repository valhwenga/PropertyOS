/**
 * The resident portal's sections, and which one a page belongs to.
 *
 * Six, in the order a resident needs them, and labelled the way a resident
 * would say them: Home rather than Overview, Maintenance rather than Requests,
 * Lease details rather than Your lease.
 *
 * The same list drives the sidebar on a laptop and the bottom bar on a phone.
 * `primary` is what fits across the bottom of a 360px screen; the rest live
 * behind More, with the account actions.
 *
 * Free of JSX and of React, so the rules can be tested on their own.
 */

export interface PortalSection {
  /** Appended to /portal/<leaseId>. Empty is the tenancy's own front page. */
  href: string;
  label: string;
  /** What this section answers, for the More sheet. */
  hint: string;
  /** On the bottom bar on a phone, rather than behind More. */
  primary: boolean;
  /**
   * A single glyph, drawn with text rather than an icon font.
   *
   * The product has no icon set and inventing one for five items would be a
   * dependency and a drawing problem. These are conventional enough to read at
   * a glance, and every one is paired with its label — never a bare glyph.
   */
  glyph: string;
}

export const PORTAL_SECTIONS: readonly PortalSection[] = [
  { href: '', label: 'Home', hint: 'What you owe and how to pay it', primary: true, glyph: '⌂' },
  { href: '/statement', label: 'Statement', hint: 'Every charge and payment', primary: true, glyph: '▤' },
  { href: '/requests', label: 'Maintenance', hint: 'Problems you have reported', primary: true, glyph: '✸' },
  { href: '/documents', label: 'Documents', hint: 'Files shared with you', primary: true, glyph: '🗎' },
  { href: '/lease', label: 'Lease details', hint: 'Dates, rent terms and who to contact', primary: false, glyph: '≡' },
  // Behind More rather than on the bottom bar: a resident reads an inspection
  // report once or twice in a tenancy, and the four primary sections are what
  // fits across a 360px screen. It is still a section of its own, because a
  // report that can cost somebody their deposit should not be buried inside
  // Documents as a file.
  { href: '/inspections', label: 'Inspections', hint: 'Reports on your home, and your response', primary: false, glyph: '◉' },
] as const;

export const PRIMARY_SECTIONS = PORTAL_SECTIONS.filter((s) => s.primary);
export const MORE_SECTIONS = PORTAL_SECTIONS.filter((s) => !s.primary);

/**
 * Whether a section contains the current page.
 *
 * Home is the section root, so it matches only itself; a prefix test would
 * light it up everywhere. The others claim their descendants, so the form at
 * /requests/new keeps Maintenance marked.
 *
 * The boundary is a whole path segment: /lease never claims /lease-archive.
 */
export function isCurrentPortalSection(
  pathname: string, base: string, href: string,
): boolean {
  const here = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
  const target = `${base}${href}`;
  if (href === '') return here === target;
  return here === target || here.startsWith(`${target}/`);
}

/** Whether the More sheet should read as the current place. */
export function isCurrentMore(pathname: string, base: string): boolean {
  return MORE_SECTIONS.some((s) => isCurrentPortalSection(pathname, base, s.href));
}
