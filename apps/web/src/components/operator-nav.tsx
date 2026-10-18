'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SectionIcon } from './icons';
import { isCurrentSection, OVERVIEW, type Section } from './operator-sections';

/**
 * The console's section list, grouped.
 *
 * This is the one client component in the operator chrome, and it exists only
 * to read the pathname: a sidebar that does not say where you are is worse than
 * a top bar that does not, because it is always on screen.
 *
 * It imports nothing from the domain package at run time. Pulling that barrel
 * into a client file drags `postgres`, and so `node:net`, into the browser
 * bundle — which has broken a route in this app before. The group list arrives
 * as a prop, already filtered by the server to what this member may use.
 *
 * The headings are real headings to a screen reader as well as to the eye: the
 * list is wrapped per group and labelled, so moving by group is possible rather
 * than arrowing through sixteen undifferentiated links.
 */
export interface NavGroup {
  key: string;
  label: string;
  sections: Section[];
}

function Item({ base, section }: { base: string; section: Section }) {
  const pathname = usePathname() ?? '';
  const current = isCurrentSection(pathname, base, section.href);
  return (
    <li>
      <Link
        href={`${base}${section.href}`}
        // aria-current is what tells a screen reader which section this is;
        // the colour and the left marker are the sighted equivalents. None of
        // the three carries it alone.
        aria-current={current ? 'page' : undefined}
        className={[
          'group relative flex items-center gap-2.5 rounded-[var(--radius-control)]',
          'px-2.5 py-1.5 text-[length:var(--text-table)] transition-colors',
          current
            ? 'bg-spike-50 font-semibold text-spike-700'
            : 'font-medium text-ink-700 hover:bg-ink-100 hover:text-ink-900',
        ].join(' ')}
      >
        <SectionIcon
          name={section.icon}
          className={[
            'size-[18px] shrink-0 transition-colors',
            current ? 'text-spike-600' : 'text-ink-400 group-hover:text-ink-700',
          ].join(' ')}
        />
        <span className="truncate">{section.label}</span>
      </Link>
    </li>
  );
}

export function OperatorNav({
  base, groups, awaitingSecondFactor,
}: {
  base: string;
  groups: NavGroup[];
  /**
   * Sections this member's roles include and this session cannot reach for
   * want of a second factor. Shown as one line with the way out, rather than
   * as nothing at all.
   */
  awaitingSecondFactor: number;
}) {
  return (
    <nav aria-label="Sections" className="px-3 py-2">
      <ul className="space-y-0.5">
        <Item base={base} section={OVERVIEW} />
      </ul>

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`nav-${group.key}`} className="mt-5">
          <h2
            id={`nav-${group.key}`}
            className="
              px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400
            "
          >
            {group.label}
          </h2>
          <ul className="space-y-0.5">
            {group.sections.map((section) => (
              <Item key={section.href} base={base} section={section} />
            ))}
          </ul>
        </section>
      ))}

      {awaitingSecondFactor > 0 ? (
        <p className="mt-5 rounded-[var(--radius-control)] bg-caution-50 px-2.5 py-2 text-[length:var(--text-meta)] text-caution-700">
          {awaitingSecondFactor === 1
            ? 'One more section is yours once you set up an authenticator.'
            : `${awaitingSecondFactor} more sections are yours once you set up an authenticator.`}{' '}
          <Link href="/account/security" className="font-semibold underline">
            Set one up
          </Link>
          .
        </p>
      ) : null}
    </nav>
  );
}
