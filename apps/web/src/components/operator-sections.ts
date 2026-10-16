/**
 * The operator console's sections, how they are grouped, and the rule for
 * which one a page belongs to.
 *
 * Deliberately free of JSX and of React, so the rules can be tested directly
 * without a component-rendering toolchain — and so nothing about them depends
 * on where they are rendered.
 *
 * The permission names are a TYPE-ONLY import. The sidebar is a client
 * component, and pulling the domain barrel into a client file drags
 * `postgres`, and so `node:net`, into the browser bundle — which has broken a
 * route in this app before. A type import is erased entirely; a value import
 * from the same package would not be.
 */
import type { PermissionKey } from '@propertyos/domain';

export interface Section {
  href: string;
  label: string;
  /**
   * The permissions that make this section worth offering. Holding ANY of them
   * is enough, because several sections serve more than one job: Approvals is
   * useful to a deposit approver and to a spend approver, and neither holds
   * the other's permission.
   *
   * Empty means the section is offered to every member.
   */
  anyOf: readonly PermissionKey[];
}

export interface SectionGroup {
  key: string;
  label: string;
  sections: readonly Section[];
}

/**
 * Overview sits outside the groups.
 *
 * It is the console's front door rather than a member of any one area, and
 * giving it a heading of its own would put a one-item group above the four
 * that matter.
 */
export const OVERVIEW: Section = { href: '', label: 'Overview', anyOf: [] };

/**
 * The four areas, in the order a month is worked: what you own, what it earns,
 * what it costs you to keep, and how the organisation itself is run.
 *
 * Approvals is grouped under Finance rather than Operations because every row
 * in that queue is a decision about money — a deposit payout, a quotation, a
 * supplier's invoice — even when the work it pays for is operational.
 */
export const NAV_GROUPS: readonly SectionGroup[] = [
  {
    key: 'portfolio',
    label: 'Portfolio',
    sections: [
      { href: '/portfolio', label: 'Properties', anyOf: ['portfolio.read'] },
      { href: '/residents', label: 'Residents', anyOf: ['resident.read'] },
      { href: '/applications', label: 'Applications', anyOf: ['lease.create'] },
      { href: '/leases', label: 'Leases', anyOf: ['lease.read'] },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    sections: [
      { href: '/billing', label: 'Billing', anyOf: ['billing.preview', 'billing.post'] },
      {
        href: '/reconciliation',
        label: 'Reconciliation',
        anyOf: ['payment.record', 'payment.allocate', 'bank.import'],
      },
      { href: '/deposits', label: 'Deposits', anyOf: ['deposit.read'] },
      { href: '/expenses', label: 'Expenses', anyOf: ['expense.record', 'expense.approve'] },
      {
        href: '/approvals',
        label: 'Approvals',
        anyOf: ['deposit.refund.approve', 'expense.approve', 'maintenance.quote.approve'],
      },
      { href: '/reports', label: 'Reports', anyOf: ['report.read'] },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    sections: [
      { href: '/maintenance', label: 'Maintenance', anyOf: ['maintenance.read'] },
      { href: '/inspections', label: 'Inspections', anyOf: ['inspection.manage'] },
      { href: '/documents', label: 'Documents', anyOf: ['document.read'] },
    ],
  },
  {
    key: 'administration',
    label: 'Administration',
    sections: [
      { href: '/onboarding', label: 'Import', anyOf: ['property.create'] },
      {
        href: '/settings',
        label: 'Settings',
        anyOf: [
          'organisation.settings.manage', 'membership.manage', 'lease.template.manage',
          'bank_account.read', 'audit.read', 'support.access.manage',
        ],
      },
    ],
  },
] as const;

/** Every section, flat and in order, Overview first. */
export const NAV: readonly Section[] = [
  OVERVIEW,
  ...NAV_GROUPS.flatMap((group) => group.sections),
];

/**
 * Every permission any section depends on, with no duplicates.
 *
 * The layout resolves these in one query rather than one per section: sixteen
 * round trips to render a sidebar would be paid on every page in the console.
 */
export const SECTION_PERMISSIONS: readonly PermissionKey[] =
  [...new Set(NAV.flatMap((section) => section.anyOf))];

/**
 * The groups this member should be offered, with the sections they cannot use
 * removed, and any group thereby left empty removed with them.
 *
 * This is a courtesy, not a control. A finance preparer who types
 * `/settings/staff` still reaches the page, and is still refused there by the
 * server — hiding a link has never stopped anybody following it. What this
 * fixes is a sidebar of sixteen entries where half answer "you may not", which
 * teaches a new colleague that the product is mostly closed to them.
 */
export function visibleGroups(
  allowed: Iterable<string>,
): Array<{ key: string; label: string; sections: Section[] }> {
  const held = new Set(allowed);
  return NAV_GROUPS
    .map((group) => ({
      key: group.key,
      label: group.label,
      sections: group.sections.filter(
        (section) => section.anyOf.length === 0 || section.anyOf.some((p) => held.has(p)),
      ),
    }))
    .filter((group) => group.sections.length > 0);
}

/**
 * How many sections this member's roles DO include and this session cannot
 * reach, because those roles require a second factor and this session has only
 * a password.
 *
 * Counted rather than hidden silently. An organisation administrator who has
 * not enrolled holds every permission in the product and resolves none of
 * them, so without this their sidebar is Overview and nothing else: a product
 * that looks broken, with no hint that enrolment is the way in.
 */
export function sectionsAwaitingSecondFactor(
  allowed: Iterable<string>,
  withheldForSecondFactor: Iterable<string>,
): number {
  const held = new Set(allowed);
  const withheld = new Set(withheldForSecondFactor);
  if (withheld.size === 0) return 0;
  return NAV_GROUPS
    .flatMap((group) => group.sections)
    .filter((section) => !section.anyOf.some((p) => held.has(p)))
    .filter((section) => section.anyOf.some((p) => withheld.has(p)))
    .length;
}

/**
 * Decides whether a section contains the current page.
 *
 * Overview is the section root, so it matches only itself — a prefix test would
 * light it up on every page in the console. Every other section also claims its
 * descendants, so a lease detail page keeps Leases marked.
 *
 * The boundary matters: the match is on a whole path segment, so /leases never
 * claims a sibling such as /leases-archive.
 */
export function isCurrentSection(pathname: string, base: string, href: string): boolean {
  const here = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
  const target = `${base}${href}`;
  if (href === '') return here === target;
  return here === target || here.startsWith(`${target}/`);
}
