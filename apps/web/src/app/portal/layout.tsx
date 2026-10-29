import Link from 'next/link';
import { AccountLink } from '@/components/account-link';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { countUnreadNotifications, getBrandingForLease } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';

/**
 * Resident portal shell.
 *
 * Mobile-first: usable one-handed at 360px with no horizontal scrolling, and
 * with the sections along the bottom where a thumb already is.
 *
 * The header carries the person and their account controls. Whose mark sits in
 * it depends on how many tenancies this person has: with ONE there is exactly
 * one landlord, and the header is theirs. With two or more there is no single
 * answer, so the header stays neutral and each landlord's mark appears where it
 * is unambiguous — beside the property, inside the tenancy itself.
 *
 * Platform attribution sits in the footer, once, quietly. The portal is the
 * landlord's front door; Spike is the machinery.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  const only = viewer.residentLeases.length === 1 ? viewer.residentLeases[0]! : null;
  const { unread, branding } = await readAs(viewer, async (tx) => ({
    unread: await countUnreadNotifications(tx, viewer.authUserId),
    branding: only ? await getBrandingForLease(tx, only.leaseId) : null,
  }));
  // The bottom padding clears the fixed section bar and, beneath it, the home
  // indicator on a phone that has one. It lives on the whole column so the
  // footer clears the bar as well — padding only the page content would leave
  // the attribution underneath it.
  return (
    <div
      className="flex min-h-dvh flex-col bg-ink-50"
      style={{ paddingBottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
    >
      <header className="border-b border-ink-100 bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/portal"
            className="rounded text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
          >
            {/* One tenancy, one landlord: their mark. The alt text is the
                destination rather than the brand, because the image is a link
                to the resident's own tenancies. */}
            {only && branding?.hasLogo ? (
              <img
                src={`/portal/${only.leaseId}/brand-logo?v=${branding?.logoVersion ?? 'current'}`}
                alt=""
                className="h-9 w-auto max-w-[12rem] object-contain object-left"
              />
            ) : (
              <Wordmark compact />
            )}
            <span className="sr-only">Your tenancies</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/account"
              className="hidden rounded text-sm text-ink-500 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500 sm:inline"
            >
              {viewer.fullName}
            </Link>
            <AccountLink unread={unread} compact />
            <ThemeToggle />
            {/* On a phone this lives under More, where the rest of the account
                actions are; two sign-out buttons on one screen is one too many. */}
            <form action="/sign-out" method="post" className="hidden md:block">
              <button
                type="submit"
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-5">{children}</main>

      <footer className="mx-auto w-full max-w-4xl px-4 pb-6 pt-2">
        <p className="text-xs text-ink-400">Powered by Spike Technologies</p>
      </footer>
    </div>
  );
}
