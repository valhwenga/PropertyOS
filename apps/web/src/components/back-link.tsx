import Link from 'next/link';
import { Icons } from './icons';

/**
 * The way back out of a page you opened from a list.
 *
 * The console has a sidebar, which answers "where else can I go" and not
 * "where did I come from". A lease, a ticket, a report or a settings page
 * REPLACES the list that led to it, and several of them had no way back at
 * all: the browser's own button, or the sidebar and then the list again.
 *
 * So every page that is a child of another carries one of these, in the same
 * place, with the same words: the name of the thing you are going back to. It
 * is deliberately not "Back", which tells somebody nothing about where they
 * will land.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="
        -ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5
        text-[length:var(--text-meta)] text-ink-500 hover:text-ink-900
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-spike-500
      "
    >
      <Icons.chevronLeft className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}
