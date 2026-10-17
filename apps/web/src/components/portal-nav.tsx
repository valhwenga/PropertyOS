'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  isCurrentMore, isCurrentPortalSection, MORE_SECTIONS, PORTAL_SECTIONS, PRIMARY_SECTIONS,
} from './portal-sections';

/**
 * The resident's navigation: a sidebar on a laptop, a bottom bar on a phone.
 *
 * A client component for two reasons — marking the current section means
 * reading the pathname, and More is a disclosure. It imports nothing from the
 * domain package, so no database driver follows it into the browser bundle.
 *
 * The bottom bar is where a thumb already is. It is fixed, so the page beneath
 * carries padding to match, and it sits above the home indicator on a phone
 * that has one: `env(safe-area-inset-bottom)` is added to its padding rather
 * than to its height, so the touch targets stay the size they look.
 */

const TARGET = 'min-h-11 min-w-11'; // 44px: the smallest comfortable target.

export function PortalSidebar({ base }: { base: string }) {
  const pathname = usePathname() ?? '';
  return (
    <nav aria-label="Your tenancy" className="hidden md:block">
      <ul className="flex flex-col gap-0.5">
        {PORTAL_SECTIONS.map((section) => {
          const current = isCurrentPortalSection(pathname, base, section.href);
          return (
            <li key={section.href}>
              <Link
                href={`${base}${section.href}`}
                aria-current={current ? 'page' : undefined}
                className={[
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                  'focus-visible:outline-spike-500',
                  current
                    ? 'bg-spike-50 font-medium text-spike-700'
                    : 'text-ink-700 hover:bg-ink-50',
                ].join(' ')}
              >
                <span aria-hidden="true" className="w-4 text-center text-ink-400">
                  {section.glyph}
                </span>
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function PortalBottomNav({
  base, moreItems,
}: {
  base: string;
  /** Account actions that belong under More beside the extra sections. */
  moreItems: Array<{ href: string; label: string; external?: boolean }>;
}) {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const moreCurrent = isCurrentMore(pathname, base);

  return (
    <>
      {/* The sheet. Rendered before the bar so the bar stays on top of it, and
          dismissed by its own backdrop — a menu with no way out is a trap on a
          phone, where there is no Escape key. */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close the menu"
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setOpen(false)}
          />
          <div
            className="
              absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-ink-100 bg-surface
              px-4 pt-4
            "
            style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">More</p>
            <ul className="mt-2 divide-y divide-ink-100">
              {MORE_SECTIONS.map((section) => (
                <li key={section.href}>
                  <Link
                    href={`${base}${section.href}`}
                    onClick={() => setOpen(false)}
                    className={`flex ${TARGET} flex-col justify-center py-2`}
                  >
                    <span className="text-sm font-medium text-ink-900">{section.label}</span>
                    <span className="text-xs text-ink-500">{section.hint}</span>
                  </Link>
                </li>
              ))}
              {moreItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={`flex ${TARGET} items-center text-sm font-medium text-ink-900`}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                {/* A real form, not a link: signing out is a POST, because a
                    GET that ends a session is a request any page could forge. */}
                <form action="/sign-out" method="post">
                  <button
                    type="submit"
                    className={`flex ${TARGET} w-full items-center text-left text-sm font-medium text-ink-900`}
                  >
                    Sign out
                  </button>
                </form>
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      <nav
        aria-label="Sections"
        className="
          fixed inset-x-0 bottom-0 z-50 border-t border-ink-100 bg-surface md:hidden
        "
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="flex">
          {PRIMARY_SECTIONS.map((section) => {
            const current = isCurrentPortalSection(pathname, base, section.href);
            return (
              <li key={section.href} className="flex-1">
                <Link
                  href={`${base}${section.href}`}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={[
                    `flex ${TARGET} flex-col items-center justify-center gap-0.5 px-1 py-2`,
                    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
                    'focus-visible:outline-spike-500',
                    current ? 'text-spike-700' : 'text-ink-500',
                  ].join(' ')}
                >
                  <span aria-hidden="true" className="text-base leading-none">{section.glyph}</span>
                  <span className="text-[11px] font-medium leading-tight">{section.label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-current={moreCurrent && !open ? 'page' : undefined}
              className={[
                `flex ${TARGET} w-full flex-col items-center justify-center gap-0.5 px-1 py-2`,
                'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
                'focus-visible:outline-spike-500',
                open || moreCurrent ? 'text-spike-700' : 'text-ink-500',
              ].join(' ')}
            >
              <span aria-hidden="true" className="text-base leading-none">⋯</span>
              <span className="text-[11px] font-medium leading-tight">More</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
