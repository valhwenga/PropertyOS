/**
 * The section-matching rule behind the sidebar's current-page marking.
 *
 * Two mistakes are easy here and both look fine on the overview page: a prefix
 * test lights Overview up everywhere, because its href is the section root; and
 * a bare startsWith lets /leases claim a sibling whose name merely begins the
 * same way.
 */
import { describe, it, expect } from 'vitest';
import { isCurrentSection, NAV } from '../../apps/web/src/components/operator-sections';

const BASE = '/app/demo-blue-crane';

describe('isCurrentSection', () => {
  it('marks Overview only on the console root', () => {
    expect(isCurrentSection(`${BASE}`, BASE, '')).toBe(true);
    expect(isCurrentSection(`${BASE}/leases`, BASE, '')).toBe(false);
    expect(isCurrentSection(`${BASE}/settings`, BASE, '')).toBe(false);
  });

  it('marks a section on its own page', () => {
    expect(isCurrentSection(`${BASE}/leases`, BASE, '/leases')).toBe(true);
  });

  it('keeps the section marked on a page beneath it', () => {
    const lease = `${BASE}/leases/eb0434c5-4f4b-4199-88f6-3738aefa5eb8`;
    expect(isCurrentSection(lease, BASE, '/leases')).toBe(true);
    expect(isCurrentSection(`${lease}/agreement`, BASE, '/leases')).toBe(true);
  });

  it('does not let a section claim one whose name merely starts the same', () => {
    expect(isCurrentSection(`${BASE}/leases-archive`, BASE, '/leases')).toBe(false);
    expect(isCurrentSection(`${BASE}/reportsx`, BASE, '/reports')).toBe(false);
  });

  it('does not leak across organisations', () => {
    expect(isCurrentSection('/app/other-org/leases', BASE, '/leases')).toBe(false);
  });

  it('tolerates a trailing slash', () => {
    expect(isCurrentSection(`${BASE}/`, BASE, '')).toBe(true);
    expect(isCurrentSection(`${BASE}/leases/`, BASE, '/leases')).toBe(true);
  });

  it('marks exactly one section for any page in the console', () => {
    const pages = [
      `${BASE}`,
      `${BASE}/leases`,
      `${BASE}/leases/eb0434c5-4f4b-4199-88f6-3738aefa5eb8`,
      `${BASE}/documents`,
      `${BASE}/onboarding`,
      `${BASE}/settings`,
    ];
    for (const page of pages) {
      const matched = NAV.filter((i) => isCurrentSection(page, BASE, i.href));
      expect(matched.map((m) => m.label), `for ${page}`).toHaveLength(1);
    }
  });
});
