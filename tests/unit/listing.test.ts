/**
 * Paging arithmetic, and the search term that reaches LIKE.
 *
 * The sentence under a list is the only thing that tells somebody whether they
 * have seen everything, so it has to be right at the edges: an empty set, a
 * single page, the last page with a partial row count. And a search box feeds
 * a LIKE pattern, where an unescaped `%` turns "50%" into "anything".
 */
import { describe, it, expect } from 'vitest';
import { likeTerm, pageHref, readPaging, summarise, PAGE_SIZE } from '../../apps/web/src/lib/listing';

describe('readPaging', () => {
  it('starts at the first page', () => {
    expect(readPaging(undefined)).toEqual({ page: 1, limit: PAGE_SIZE, offset: 0 });
  });

  it('offsets by whole pages', () => {
    expect(readPaging('3', 50)).toEqual({ page: 3, limit: 50, offset: 100 });
  });

  it('treats a nonsense page as the first one rather than as nothing', () => {
    for (const bad of ['0', '-2', 'banana', '1.5', '']) {
      expect(readPaging(bad).page, `for ${bad}`).toBe(1);
    }
  });
});

describe('likeTerm', () => {
  it('is null when nothing was typed', () => {
    expect(likeTerm(undefined)).toBeNull();
    expect(likeTerm('   ')).toBeNull();
  });

  it('matches anywhere in the value', () => {
    expect(likeTerm('mokoena')).toBe('%mokoena%');
  });

  it('makes the wildcards literal', () => {
    // Without this, "LSE_0001" matches LSE-0001 and LSE/0001 too, and a
    // search for "100%" matches every row in the table.
    expect(likeTerm('LSE_0001')).toBe('%LSE\\_0001%');
    expect(likeTerm('100%')).toBe('%100\\%%');
    expect(likeTerm('back\\slash')).toBe('%back\\\\slash%');
  });
});

describe('summarise', () => {
  const paging = (page: number) => readPaging(String(page), 50);

  it('says the whole count when everything fits on one page', () => {
    expect(summarise(paging(1), 12, 12, false).sentence).toBe('12 records');
    expect(summarise(paging(1), 1, 1, false).sentence).toBe('1 record');
    expect(summarise(paging(1), 0, 0, false).sentence).toBe('0 records');
  });

  it('says which part of the set is on screen once it does not', () => {
    expect(summarise(paging(1), 50, 213, false).sentence).toBe('Showing 1–50 of 213 records');
    expect(summarise(paging(3), 50, 213, false).sentence).toBe('Showing 101–150 of 213 records');
    expect(summarise(paging(5), 13, 213, false).sentence).toBe('Showing 201–213 of 213 records');
  });

  it('offers a next page only while one exists', () => {
    expect(summarise(paging(1), 50, 213, false).next).toBe(2);
    expect(summarise(paging(5), 13, 213, false).next).toBeNull();
    expect(summarise(paging(1), 12, 12, false).next).toBeNull();
  });

  it('offers a previous page only once past the first', () => {
    expect(summarise(paging(1), 50, 213, false).previous).toBeNull();
    expect(summarise(paging(2), 50, 213, false).previous).toBe(1);
  });
});

describe('pageHref', () => {
  it('carries every other filter, so paging never widens the list', () => {
    const href = pageHref({ q: 'mokoena', status: 'active', page: '2' }, 3);
    expect(href).toContain('q=mokoena');
    expect(href).toContain('status=active');
    expect(href).toContain('page=3');
  });

  it('drops the page number on the first page, so the plain URL is the plain list', () => {
    expect(pageHref({ page: '4' }, 1)).toBe('');
    expect(pageHref({ q: 'x', page: '4' }, 1)).toBe('?q=x');
  });

  it('keeps repeated values', () => {
    const href = pageHref({ property: ['a', 'b'] }, 2);
    expect(href.match(/property=/g)).toHaveLength(2);
  });
});
