'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { splitEnvironmentLabel } from './environment-label';
import { Icons } from './icons';
import { OperatorNav, type NavGroup } from './operator-nav';
import { OrganisationSwitcher } from './organisation-switcher';
import { Wordmark } from './wordmark';

/**
 * The console sidebar, rendered ONCE.
 *
 * The obvious way to get a sidebar on a laptop and a drawer on a phone is to
 * write the navigation twice and hide one with a media query. That costs more
 * than it looks: a screen reader meets two navigation landmarks and every link
 * twice, and any test that asks for a link by its name finds two of them. So
 * there is one copy, moved by CSS, and the mobile drawer is the same element
 * slid in from the left.
 *
 * Client because it holds the drawer's open state and reads the pathname. It
 * takes the account controls as children rather than importing them, so the
 * server keeps rendering what the server should.
 */
export function ConsoleSidebar({
  slug, organisationName, userName, groups, awaitingSecondFactor, organisations,
  logoSrc, accountControls,
}: {
  slug: string;
  organisationName: string;
  userName: string;
  groups: NavGroup[];
  awaitingSecondFactor: number;
  organisations: Array<{ slug: string; name: string }>;
  /** The organisation's own logo, when one has been uploaded. */
  logoSrc: string | null;
  accountControls: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Following a link closes the drawer: on a phone it covers the page it just
  // navigated to.
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const environment = splitEnvironmentLabel(organisationName);
  const base = `/app/${slug}`;

  const identity = (
    <div className="flex min-w-0 items-center gap-2">
      {/* The landlord's own mark when they have uploaded one, and the Spike
          wordmark when they have not. Sized by height so a wide logo and a
          square one both sit on the same line, and labelled with the
          organisation's name rather than the word "logo". */}
      <Link href="/app" className="text-[length:var(--text-body)]">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={environment.name}
            className="h-7 w-auto max-w-[9rem] object-contain"
          />
        ) : (
          <Wordmark />
        )}
      </Link>
      {environment.label ? (
        <span
          title={`Synthetic ${environment.label.toLowerCase()} data`}
          className="
            rounded border border-caution-700/30 bg-caution-50 px-1.5 py-0.5
            text-[10px] font-semibold uppercase tracking-[0.08em] text-caution-700
          "
        >
          {environment.label}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      {/* The bar a phone gets instead of the sidebar. */}
      <div className="flex items-center gap-3 border-b border-ink-100 bg-surface px-4 py-2.5 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="console-sidebar"
          className="
            inline-flex size-9 items-center justify-center rounded-[var(--radius-control)]
            border border-ink-200 text-ink-700 hover:bg-ink-50
          "
        >
          <Icons.menu className="size-5" />
          <span className="sr-only">Open sections</span>
        </button>
        {identity}
        <span className="ml-auto min-w-0 truncate text-[length:var(--text-meta)] text-ink-500">
          {environment.name}
        </span>
      </div>

      {open ? (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-ink-900/40 lg:hidden"
        />
      ) : null}

      <aside
        id="console-sidebar"
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-ink-100 bg-surface',
          'transition-transform duration-200 ease-out',
          'lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-60 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3.5">
          {identity}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="
              inline-flex size-8 items-center justify-center rounded-[var(--radius-control)]
              text-ink-500 hover:bg-ink-100 lg:hidden
            "
          >
            <Icons.close className="size-5" />
            <span className="sr-only">Close sections</span>
          </button>
        </div>

        <OrganisationSwitcher current={slug} organisations={organisations} />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <OperatorNav base={base} groups={groups} awaitingSecondFactor={awaitingSecondFactor} />
        </div>

        <div className="space-y-2 border-t border-ink-100 px-3 py-3">
          <Link
            href="/account"
            className="
              flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5
              text-[length:var(--text-table)] text-ink-700 hover:bg-ink-100
            "
          >
            <span
              aria-hidden="true"
              className="
                flex size-7 shrink-0 items-center justify-center rounded-full bg-spike-50
                text-[length:var(--text-meta)] font-semibold text-spike-700
              "
            >
              {userName.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{userName}</span>
          </Link>
          {accountControls}
        </div>
      </aside>
    </>
  );
}
