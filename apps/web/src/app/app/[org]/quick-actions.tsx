'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icons } from '@/components/icons';

/**
 * The overview's quick-action menu.
 *
 * Every entry is an existing authorised workflow — it navigates to the screen
 * that already does the job, where the permission is checked as it always was.
 * Nothing here performs an action itself, and nothing is offered that does not
 * exist: a menu of plausible-sounding verbs that lead nowhere is worse than no
 * menu.
 *
 * Closes on Escape and on a click outside, and the button says whether it is
 * open. The menu items are plain links, so keyboard users tab through them and
 * a screen reader reads them as the list of links they are.
 */
export function QuickActions({ org, periodStart }: { org: string; periodStart: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const base = `/app/${org}`;
  const items: Array<{ href: string; label: string; detail: string }> = [
    {
      href: `${base}/reconciliation`,
      label: 'Record money received',
      detail: 'For funds already in the bank account',
    },
    {
      href: `${base}/billing?period=${periodStart}`,
      label: 'Prepare this month’s billing',
      detail: 'Preview, validate, then post',
    },
    {
      href: `${base}/leases/new`,
      label: 'Draft a lease',
      detail: 'A new tenancy, not yet active',
    },
    {
      href: `${base}/expenses`,
      label: 'Record a cost',
      detail: 'A supplier invoice, saved as a draft',
    },
    {
      href: `${base}/reports`,
      label: 'Run a report',
      detail: 'Rent roll, arrears ageing, collection',
    },
  ];

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="
          inline-flex items-center gap-2 rounded-[var(--radius-control)] bg-spike-500 px-3.5 py-2
          text-[length:var(--text-table)] font-medium text-white shadow-[var(--shadow-card)]
          hover:bg-spike-600
        "
      >
        <Icons.plus className="size-4" />
        Quick actions
        <Icons.chevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div
          role="menu"
          className="
            absolute right-0 z-20 mt-1.5 w-72 overflow-hidden rounded-[var(--radius-card)]
            border border-ink-100 bg-surface shadow-[var(--shadow-raised)]
          "
        >
          <ul className="divide-y divide-ink-100">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="block px-3.5 py-2.5 hover:bg-ink-50"
                >
                  <span className="block text-[length:var(--text-table)] font-medium text-ink-900">
                    {item.label}
                  </span>
                  <span className="block text-[length:var(--text-meta)] text-ink-500">
                    {item.detail}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
