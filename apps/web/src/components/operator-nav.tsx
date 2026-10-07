'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isCurrentSection, NAV } from './operator-sections';

/**
 * The console's section list.
 *
 * This is the one client component in the operator chrome, and it exists only
 * to read the pathname: a sidebar that does not say where you are is worse than
 * a top bar that does not, because it is always on screen.
 *
 * It imports nothing from the domain package. Pulling that barrel into a client
 * file drags `postgres`, and so `node:net`, into the browser bundle — which has
 * broken a route in this app before.
 */
export function OperatorNav({ base }: { base: string }) {
  const pathname = usePathname() ?? '';
  return (
    <nav aria-label="Sections" className="overflow-x-auto px-4 lg:overflow-x-visible lg:pb-4">
      <ul className="flex gap-1 pb-2 lg:flex-col lg:gap-0.5 lg:pb-0">
        {NAV.map((item) => {
          const current = isCurrentSection(pathname, base, item.href);
          return (
            <li key={item.href}>
              <Link
                href={`${base}${item.href}`}
                // aria-current is what tells a screen reader which section this
                // is; the colour is the sighted equivalent. Neither carries it
                // alone.
                aria-current={current ? 'page' : undefined}
                className={[
                  'block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm',
                  current
                    ? 'bg-spike-50 font-medium text-spike-700'
                    : 'text-ink-700 hover:bg-spike-50 hover:text-spike-700',
                ].join(' ')}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
