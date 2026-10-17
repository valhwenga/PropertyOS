'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isCurrentPortalSection, PORTAL_SECTIONS } from './portal-sections';

/**
 * The resident's section list.
 *
 * A client component for one reason, the same reason the operator console has
 * one: marking the current section means reading the pathname. It imports
 * nothing from the domain package, so no database driver follows it into the
 * browser bundle.
 *
 * Five items that WRAP on a phone and stack into a sidebar from `md` up. The
 * same markup both times: a resident's phone must not carry a second layout it
 * never shows, and a drawer would need state for a menu of five things.
 *
 * Wrapping rather than scrolling sideways, which is what the operator console
 * does with sixteen sections. Five fit on two lines, and a resident who cannot
 * see that Documents exists will not swipe a row to find out.
 */
export function PortalNav({ base }: { base: string }) {
  const pathname = usePathname() ?? '';
  return (
    <nav aria-label="Your tenancy">
      <ul className="flex flex-wrap gap-1 md:flex-col md:flex-nowrap md:gap-0.5">
        {PORTAL_SECTIONS.map((section) => {
          const current = isCurrentPortalSection(pathname, base, section.href);
          return (
            <li key={section.href}>
              <Link
                href={`${base}${section.href}`}
                // aria-current is what tells a screen reader which section this
                // is; the colour is the sighted equivalent. Neither alone.
                aria-current={current ? 'page' : undefined}
                className={[
                  'block whitespace-nowrap rounded-lg px-3 py-2 text-sm md:py-1.5',
                  current
                    ? 'bg-spike-50 font-medium text-spike-700'
                    : 'text-ink-700 hover:bg-spike-50 hover:text-spike-700',
                ].join(' ')}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
