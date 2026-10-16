/**
 * Paging and free-text search, shared by the lists that grow without limit.
 *
 * Three of them read every row in the table and filtered in JavaScript, and
 * the documents list cut itself off at 200 rows and said nothing — an operator
 * scrolled to the bottom and believed they had seen everything. Blueprint §26
 * asks for ordinary page reads under a second against 5,000 units and five
 * years of history, which no amount of client-side filtering reaches.
 *
 * No `server-only` marker and no database here: this is the arithmetic, so it
 * can be tested on its own.
 */

/** Rows per page. Enough that most organisations never page at all. */
export const PAGE_SIZE = 50;

export interface Paging {
  page: number;
  limit: number;
  offset: number;
}

export function readPaging(page: string | undefined, size = PAGE_SIZE): Paging {
  const requested = Number(page);
  // A page number that is not a number, is zero, or is negative is a mistyped
  // URL, not an instruction to show nothing.
  const safe = Number.isInteger(requested) && requested > 0 ? requested : 1;
  return { page: safe, limit: size, offset: (safe - 1) * size };
}

/**
 * Makes a search term literal.
 *
 * `%` and `_` are wildcards to LIKE, so a resident searching for a reference
 * containing an underscore would otherwise match more than they typed. The
 * backslash is escaped first or it would escape the escapes.
 */
export function likeTerm(query: string | undefined): string | null {
  const trimmed = (query ?? '').trim();
  if (trimmed === '') return null;
  return `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface PageSummary {
  /** "Showing 51–100 of 213" — or the whole-set form when there is one page. */
  sentence: string;
  previous: number | null;
  next: number | null;
  /** True when a filter is hiding part of the set, so "no rows" can say why. */
  filtered: boolean;
}

export function summarise(
  { page, limit }: Paging, shown: number, total: number, filtered: boolean,
): PageSummary {
  const first = total === 0 ? 0 : (page - 1) * limit + 1;
  const last = (page - 1) * limit + shown;
  const noun = total === 1 ? 'record' : 'records';
  return {
    sentence: total <= limit && page === 1
      ? `${total} ${noun}`
      : `Showing ${first}–${last} of ${total} ${noun}`,
    previous: page > 1 ? page - 1 : null,
    next: last < total ? page + 1 : null,
    filtered,
  };
}

/**
 * The query string for another page of the same list.
 *
 * Every other filter is carried over, so paging never silently widens what is
 * being paged through.
 */
export function pageHref(
  current: Record<string, string | string[] | undefined>, page: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (key === 'page' || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== '') params.append(key, one);
    }
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}
