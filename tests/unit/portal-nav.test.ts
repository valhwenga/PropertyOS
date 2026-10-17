/**
 * The resident portal's section-matching rule.
 *
 * The same two mistakes as the operator console's, and both look fine on the
 * front page: a prefix test lights Overview up everywhere, because its href is
 * the section root; and a bare startsWith lets a section claim a sibling whose
 * name merely begins the same way.
 */
import { describe, it, expect } from 'vitest';
import {
  isCurrentPortalSection, PORTAL_SECTIONS,
} from '../../apps/web/src/components/portal-sections';

const BASE = '/portal/ee90c335-380a-4aa1-bbb4-0bc5139f9252';

describe('isCurrentPortalSection', () => {
  it('marks Overview only on the tenancy root', () => {
    expect(isCurrentPortalSection(BASE, BASE, '')).toBe(true);
    expect(isCurrentPortalSection(`${BASE}/statement`, BASE, '')).toBe(false);
  });

  it('keeps the section marked on a page beneath it', () => {
    // The form for a new request is part of Requests, not of nothing.
    expect(isCurrentPortalSection(`${BASE}/requests/new`, BASE, '/requests')).toBe(true);
  });

  it('does not let a section claim one whose name merely starts the same', () => {
    expect(isCurrentPortalSection(`${BASE}/lease-archive`, BASE, '/lease')).toBe(false);
  });

  it('does not leak across tenancies', () => {
    expect(isCurrentPortalSection('/portal/other-lease/statement', BASE, '/statement')).toBe(false);
  });

  it('tolerates a trailing slash', () => {
    expect(isCurrentPortalSection(`${BASE}/`, BASE, '')).toBe(true);
    expect(isCurrentPortalSection(`${BASE}/documents/`, BASE, '/documents')).toBe(true);
  });

  it('marks exactly one section for any page in the portal', () => {
    const pages = [
      BASE,
      `${BASE}/statement`,
      `${BASE}/requests`,
      `${BASE}/requests/new`,
      `${BASE}/documents`,
      `${BASE}/lease`,
    ];
    for (const page of pages) {
      const matched = PORTAL_SECTIONS.filter((s) => isCurrentPortalSection(page, BASE, s.href));
      expect(matched.map((m) => m.label), `for ${page}`).toHaveLength(1);
    }
  });

  it('leaves the payment form outside the sections, deliberately', () => {
    // It is reached from Overview and from nowhere else: a resident telling
    // their landlord about a payment is finishing one task, not browsing a
    // section, and a marked tab would suggest somewhere to return to.
    const matched = PORTAL_SECTIONS.filter(
      (s) => isCurrentPortalSection(`${BASE}/payments`, BASE, s.href),
    );
    expect(matched).toHaveLength(0);
  });
});
