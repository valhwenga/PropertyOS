/**
 * The section-matching rule behind the sidebar's current-page marking.
 *
 * Two mistakes are easy here and both look fine on the overview page: a prefix
 * test lights Overview up everywhere, because its href is the section root; and
 * a bare startsWith lets /leases claim a sibling whose name merely begins the
 * same way.
 */
import { describe, it, expect } from 'vitest';
import {
  isCurrentSection, NAV, NAV_GROUPS, SECTION_PERMISSIONS, visibleGroups,
} from '../../apps/web/src/components/operator-sections';

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

describe('the grouped sidebar', () => {
  it('puts every section in exactly one group, Overview excepted', () => {
    const grouped = NAV_GROUPS.flatMap((g) => g.sections.map((s) => s.href));
    expect(new Set(grouped).size, 'a section appears in two groups').toBe(grouped.length);
    expect(grouped.sort()).toEqual(NAV.filter((s) => s.href !== '').map((s) => s.href).sort());
  });

  it('names the four areas the blueprint asks for', () => {
    expect(NAV_GROUPS.map((g) => g.label))
      .toEqual(['Portfolio', 'Finance', 'Operations', 'Administration']);
  });

  it('asks for every permission any section depends on, once', () => {
    const wanted = NAV.flatMap((s) => s.anyOf);
    expect(new Set(SECTION_PERMISSIONS)).toEqual(new Set(wanted));
    expect(SECTION_PERMISSIONS.length, 'the layout would ask twice')
      .toBe(new Set(SECTION_PERMISSIONS).size);
  });

  it('shows an administrator everything', () => {
    const groups = visibleGroups(SECTION_PERMISSIONS);
    expect(groups.flatMap((g) => g.sections)).toHaveLength(NAV.length - 1);
  });

  it('shows a finance preparer their own work and not the portfolio manager\'s', () => {
    // The grants 0008 gives finance_preparer, which is what the database
    // would answer for one.
    const sections = visibleGroups([
      'portfolio.read', 'resident.read', 'lease.read', 'billing.preview',
      'payment.record', 'payment.allocate', 'bank.import', 'deposit.read',
      'deposit.record', 'expense.record', 'report.read', 'document.read',
    ]).flatMap((g) => g.sections.map((s) => s.label));

    expect(sections).toContain('Reconciliation');
    expect(sections).toContain('Deposits');
    expect(sections).toContain('Expenses');
    // Preparing is not approving, and the queue is for the second pair of eyes.
    expect(sections).not.toContain('Approvals');
    // Nothing in Settings is theirs, and Import creates properties.
    expect(sections).not.toContain('Settings');
    expect(sections).not.toContain('Import');
    expect(sections).not.toContain('Inspections');
  });

  it('drops a group entirely when nothing in it is left', () => {
    const groups = visibleGroups(['maintenance.read', 'inspection.manage']);
    expect(groups.map((g) => g.label)).toEqual(['Operations']);
  });

  it('shows nothing but Overview to a member with no permissions at all', () => {
    expect(visibleGroups([])).toEqual([]);
  });

  it('keeps Overview out of the groups, so it is never hidden', () => {
    const inGroups = NAV_GROUPS.flatMap((g) => g.sections).some((s) => s.href === '');
    expect(inGroups).toBe(false);
    expect(NAV[0]?.href).toBe('');
  });
});
