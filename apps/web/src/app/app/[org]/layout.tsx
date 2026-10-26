import type { Metadata } from 'next';
import { OperatorShell } from '@/components/operator-shell';
import {
  countUnreadNotifications, getBranding, resolveMenuPermissions, supportScopes,
} from '@propertyos/domain';
import {
  SECTION_PERMISSIONS, sectionsAwaitingSecondFactor, visibleGroups,
} from '@/components/operator-sections';
import { getViewer, readAs, requireOperator } from '@/lib/auth';

/**
 * The browser tab is part of the branding too.
 *
 * A landlord who has set up their own mark and colours should not find
 * somebody else's product name on the tab, in a bookmark, or in the browser
 * history of every member of their staff. So the title becomes their
 * organisation's name and the icon becomes their logo.
 *
 * This resolves the slug WITHOUT redirecting: metadata is generated beside the
 * page, and a caller who may not see this organisation gets the neutral title
 * while the layout below does the actual refusing. A missing or unreadable
 * organisation therefore falls back to the product's own name rather than
 * confirming anything about whether the slug exists.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ org: string }> },
): Promise<Metadata> {
  const { org } = await params;
  const viewer = await getViewer();
  const organisation = viewer?.organisations.find((o) => o.slug === org);
  if (!viewer || !organisation) return {};

  const branding = await readAs(viewer, (tx) => getBranding(tx, organisation.id));
  return {
    title: { default: organisation.name, template: `%s · ${organisation.name}` },
    ...(branding.hasLogo
      ? {
        icons: {
          icon: [{
            url: `/app/${org}/brand-logo?v=${branding.logoVersion ?? 'current'}`,
            ...(branding.logoMime ? { type: branding.logoMime } : {}),
          }],
        },
      }
      : {}),
  };
}

export default async function OrgLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  // Resolves the slug against the viewer's OWN memberships. An unknown or
  // unauthorised slug redirects rather than revealing that it exists.
  const context = await requireOperator(org);
  // One transaction for both: the sidebar is rendered on every page in the
  // console, so what it costs is paid on every page in the console.
  const { unreadNotices, menu, branding, scopes } = await readAs(context.viewer, async (tx) => ({
    unreadNotices: await countUnreadNotifications(tx, context.viewer.authUserId),
    menu: await resolveMenuPermissions(tx, context.organisationId, SECTION_PERMISSIONS),
    // How this organisation chose to look. One small row, read on every page
    // for the same reason the sidebar is: it is on every page.
    branding: await getBranding(tx, context.organisationId),
    // Only when somebody is here on a session, so an ordinary member's page
    // load does not pay for a read that would tell them nothing.
    scopes: context.supportSession ? await supportScopes(tx) : [],
  }));
  return (
    <OperatorShell
      slug={org}
      organisationName={context.organisationName}
      userName={context.viewer.fullName}
      unreadNotices={unreadNotices}
      branding={branding}
      groups={visibleGroups(menu.held)}
      // Every organisation this person belongs to, for the switcher. Resolved
      // from their own memberships, so it can never offer one they are not in.
      organisations={context.viewer.organisations.map((o) => ({ slug: o.slug, name: o.name }))}
      awaitingSecondFactor={
        sectionsAwaitingSecondFactor(menu.held, menu.withheldForSecondFactor)
      }
      {...(context.supportSession
        ? {
          supportSession: {
            expiresAt: context.supportSession.expiresAt,
            // The customer's own words for what they allowed, not the keys.
            scopeNames: context.supportSession.scopes.map(
              (key) => scopes.find((scope) => scope.key === key)?.name ?? key,
            ),
            timeZone: context.timeZone,
          },
        }
        : {})}
    >
      {children}
    </OperatorShell>
  );
}
