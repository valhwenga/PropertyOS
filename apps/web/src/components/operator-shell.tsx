import type { Branding } from '@propertyos/domain';
import { AccountLink } from './account-link';
import { ConsoleSidebar } from './console-sidebar';
import { Icons } from './icons';
import type { NavGroup } from './operator-nav';
import { ThemeToggle } from './theme-toggle';

/**
 * The operator console's chrome.
 *
 * A sidebar on a laptop, the same sidebar as a drawer on a phone — one copy of
 * the navigation either way. This stays a server component: it renders the
 * account controls, which are client components in their own right, and hands
 * them to the sidebar as children rather than letting the client boundary
 * swallow the whole shell.
 */
export function OperatorShell({
  slug, organisationName, userName, unreadNotices, groups, awaitingSecondFactor,
  organisations, branding, children,
}: {
  slug: string; organisationName: string; userName: string;
  unreadNotices: number; groups: NavGroup[]; awaitingSecondFactor: number;
  organisations: Array<{ slug: string; name: string }>;
  branding: Branding;
  children: React.ReactNode;
}) {
  return (
    // The accent and typeface are attributes, not inline styles: the rules
    // live in the one stylesheet every tenant shares, so nothing is generated
    // per request and a brand cannot smuggle CSS into the page.
    <div
      data-brand={branding.accent}
      data-typeface={branding.typeface}
      className="min-h-dvh bg-ink-50 lg:flex"
    >
      <ConsoleSidebar
        slug={slug}
        organisationName={organisationName}
        userName={userName}
        groups={groups}
        awaitingSecondFactor={awaitingSecondFactor}
        organisations={organisations}
        logoSrc={branding.hasLogo
          ? `/app/${slug}/brand-logo?v=${branding.logoVersion ?? 'current'}`
          : null}
        accountControls={
          <div className="flex items-center gap-1.5">
            <AccountLink unread={unreadNotices} compact />
            <ThemeToggle />
            <form action="/sign-out" method="post" className="ml-auto">
              <button
                type="submit"
                className="
                  inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5
                  text-[length:var(--text-meta)] font-medium text-ink-500
                  hover:bg-ink-100 hover:text-ink-900
                "
              >
                <Icons.signOut className="size-4" />
                Sign out
              </button>
            </form>
          </div>
        }
      />

      {/* min-w-0 matters: without it a wide table — the lease statement, for one
          — stretches this flex item and pushes the whole page sideways. */}
      <div className="min-w-0 flex-1">
        <main id="main" className="mx-auto max-w-[84rem] px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
