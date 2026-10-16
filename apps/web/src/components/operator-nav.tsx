'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
        // the colour is the sighted equivalent. Neither carries it alone.
        aria-current={current ? 'page' : undefined}
        className={[
          'block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm md:py-1',
          current
            ? 'bg-spike-50 font-medium text-spike-700'
            : 'text-ink-700 hover:bg-spike-50 hover:text-spike-700',
        ].join(' ')}
      >
        {section.label}
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
    <nav aria-label="Sections" className="overflow-x-auto px-4 md:overflow-x-visible md:pb-4">
      {/* Narrow screens keep the single scrolling row they already had: four
          stacked groups down a phone would eat the top of every page. The
          groups are still groups in the markup, their headings hidden from
          sight only, so a screen reader on a phone keeps the structure the
          sidebar shows on a laptop. */}
      <div className="flex md:block">
        <ul className="flex gap-1 pb-2 md:flex-col md:gap-0.5 md:pb-0">
          <Item base={base} section={OVERVIEW} />
        </ul>

        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`nav-${group.key}`} className="md:mt-3">
            <h2
              id={`nav-${group.key}`}
              className="
                sr-only
                md:not-sr-only md:px-3 md:pb-0.5 md:text-[11px] md:font-semibold
                md:uppercase md:tracking-wide md:text-ink-400
              "
            >
              {group.label}
            </h2>
            <ul className="flex gap-1 pb-2 md:flex-col md:gap-0.5 md:pb-0">
              {group.sections.map((section) => (
                <Item key={section.href} base={base} section={section} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Shown at every width. On a phone it is a second line under the
          scrolling row, which is a cost worth paying: the member most likely
          to see it is an administrator whose sidebar is otherwise empty. */}
      {awaitingSecondFactor > 0 ? (
        <p className="mb-2 rounded-lg bg-caution-50 px-3 py-2 text-xs text-caution-700 md:mb-0 md:mt-4">
          {awaitingSecondFactor === 1
            ? 'One more section is yours once you set up an authenticator.'
            : `${awaitingSecondFactor} more sections are yours once you set up an authenticator.`}{' '}
          <Link href="/account/security" className="font-medium underline">
            Set one up
          </Link>
          .
        </p>
      ) : null}
    </nav>
  );
}
