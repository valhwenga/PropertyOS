import type { SVGProps } from 'react';

/**
 * One line-icon set, drawn to the same rules.
 *
 * 24-unit grid, 1.5 stroke, round caps and joins, no fills. Mixing icon styles
 * is one of the things that makes an interface look assembled rather than
 * designed, so these are drawn here rather than pulled from two libraries — and
 * drawn rather than installed, because sixteen glyphs do not justify a
 * dependency in the browser bundle of every page.
 *
 * Every icon is decorative: the label beside it carries the meaning, and each
 * is hidden from assistive technology.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  overview: (p: IconProps) => (
    <Svg {...p}><path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z" /></Svg>
  ),
  properties: (p: IconProps) => (
    <Svg {...p}><path d="M3 20h18M5 20V9l7-5 7 5v11M10 20v-5h4v5" /></Svg>
  ),
  residents: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M18 20a5 5 0 0 0-2-4" />
    </Svg>
  ),
  applications: (p: IconProps) => (
    <Svg {...p}><path d="M8 3h8l4 4v14H4V3zM16 3v5h4M8 13h8M8 17h5" /></Svg>
  ),
  leases: (p: IconProps) => (
    <Svg {...p}><path d="M6 3h9l4 4v14H6zM15 3v5h4M9 12h7M9 16h4" /><circle cx="9.5" cy="8.5" r="0" /></Svg>
  ),
  billing: (p: IconProps) => (
    <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></Svg>
  ),
  reconciliation: (p: IconProps) => (
    <Svg {...p}><path d="M4 7h11l-3-3M20 17H9l3 3" /><path d="M4 7l3 3M20 17l-3-3" opacity="0" /></Svg>
  ),
  deposits: (p: IconProps) => (
    <Svg {...p}><path d="M4 9l8-5 8 5M5 9v9m14-9v9M3 20h18M9 18v-5h6v5" /></Svg>
  ),
  expenses: (p: IconProps) => (
    <Svg {...p}><path d="M3 7h18v12H3zM3 11h18M7 15h3" /><path d="M7 7V5h10v2" /></Svg>
  ),
  approvals: (p: IconProps) => (
    <Svg {...p}><path d="M20 7 10 17l-5-5" /></Svg>
  ),
  reports: (p: IconProps) => (
    <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>
  ),
  maintenance: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14.5 5.5a4 4 0 0 0 5 5L21 9v6l-9 6-6-6 6-9h6z" opacity="0" />
      <path d="M9 15l-4.5 4.5a2 2 0 0 0 3 3L12 18M14 11l6-6M16 4h4v4M13 12a4 4 0 1 1 4-4" />
    </Svg>
  ),
  inspections: (p: IconProps) => (
    <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5M9 11l1.5 1.5L14 9" /></Svg>
  ),
  documents: (p: IconProps) => (
    <Svg {...p}><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4" /></Svg>
  ),
  import: (p: IconProps) => (
    <Svg {...p}><path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v3h16v-3" /></Svg>
  ),
  settings: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" />
    </Svg>
  ),
  menu: (p: IconProps) => (
    <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
  ),
  close: (p: IconProps) => (
    <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
  ),
  chevronDown: (p: IconProps) => (
    <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
  ),
  signOut: (p: IconProps) => (
    <Svg {...p}><path d="M15 4h4v16h-4M11 8l-4 4 4 4M7 12h10" /></Svg>
  ),
  bell: (p: IconProps) => (
    <Svg {...p}><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6M10 19a2 2 0 0 0 4 0" /></Svg>
  ),
  plus: (p: IconProps) => (
    <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
  ),
} as const;

export type IconName = keyof typeof Icons;

/** Renders a section icon by name, falling back to nothing rather than a box. */
export function SectionIcon({ name, className }: { name?: string; className?: string }) {
  if (!name) return null;
  const Icon = Icons[name as IconName];
  return Icon ? <Icon className={className} /> : null;
}
